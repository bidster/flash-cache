# @bidster/flash-cache

Двухуровневый кеш для Node.js с единым `getOrSet`, синхронным быстрым путём, singleflight и stale-while-revalidate.

```sh
npm install @bidster/flash-cache
```

```ts
import { FlashCache, MapStore } from '@bidster/flash-cache';

const cache = new FlashCache<number>(new MapStore<number>(), new MapStore<number>(), {
  ttl: 60_000,
  staleRatio: 0.8,
  namespace: 'counts',
  onError: (error, context) => console.error(context, error),
});

const count = cache.getOrSet('users', () => 42); // Первый промах тоже синхронный с MapStore.
const hit = cache.getOrSet('users', async () => 100); // 42 синхронно

await cache.set('users', 50, { customTtl: 30_000 });
const stored = await cache.get('users'); // 50 или undefined при промахе
await cache.delete('users');
```

## Синхронный результат и MayBePromise

`MayBePromise<T>` означает `T | Promise<T>`: метод возвращает **само значение**, если результат доступен синхронно. `await` не обязателен. Один и тот же вызов может вернуть Promise на промахе и обычное значение при следующем попадании в L1 — даже с асинхронной factory и Redis в качестве L2.

```ts
const result = cache.getOrSet('users', async () => 42);

if (result instanceof Promise) {
  result.then((count) => console.log(count)).catch(console.error);
} else {
  console.log(result); // Выполняется сразу, в текущем стеке вызовов.
}
```

- **Fresh L1:** значение синхронно, без создания Promise и обращения к L2; factory не вызывается.
- **Допустимый stale L1:** значение синхронно, хотя обновление может продолжаться асинхронно.
- **Промах:** результат синхронный, если чтение L2, factory и запись L2 выполняются синхронно. Асинхронная операция, необходимая для ответа, приводит к Promise.
- **`get`:** возвращает значение или `undefined` синхронно, если чтение синхронно; при асинхронном чтении L2 возвращает Promise. Factory не запускается.

`await cache.getOrSet(...)` корректен в обоих случаях, но продолжение после `await` всегда откладывается в микрозадачу, даже если кеш вернул обычное значение. Чтобы сохранить синхронную обработку, используйте ветвление выше и не объявляйте обёртку `async`: `async`-функция всегда возвращает Promise. `cloneValue` синхронна и не меняет этот выбор.

Ошибки синхронного пути могут выбрасываться непосредственно из вызова; ошибки асинхронного пути отклоняют Promise. Для их общей обработки можно использовать `try/catch` вокруг `await`, а для сохранения синхронного пути — `try/catch` вокруг вызова вместе с `.catch()` в Promise-ветке.

## Срок жизни и обновление

TTL задаётся положительным целым числом миллисекунд. `staleRatio` определяет начало обновления: `0.8` означает, что после 80% TTL значение отдаётся как stale с обновлением в фоне. После полного истечения TTL оно не выдаётся. Перенос L2 → L1 сохраняет исходные сроки жизни. После ответа L2 активная операция повторно проверяет L1: если там уже есть fresh-значение, использует его без перезаписи и без вызова factory. Stale и expired L1 не имеют такого приоритета.

Один singleflight на ключ и экземпляр объединяет чтение L2, factory и запись. `set/delete` отсоединяют старую загрузку: ожидающие читатели получают её результат, но он больше не публикуется в кеше. Уже отправленную запись L2 отменить нельзя; межпроцессной координации нет.

## Переопределение stale и jitter

В `getOrSet` и `set` можно передать `customStaleRatio` от `0` до `1`, отдельно от `customTtl`. Он влияет только на новую запись; существующие сроки не изменяются. При singleflight factory, TTL и staleRatio определяет первый вызов. Для последующих обновлений передавайте опцию снова.

```ts
import { jitter } from '@bidster/flash-cache';

const ttlMs = 24 * 60 * 60 * 1000;
const freshForMs = 5 * 60 * 1000;

function getUserCount() {
  return cache.getOrSet('users', () => loadUserCount(), {
    customTtl: ttlMs,
    customStaleRatio: jitter(freshForMs, 0.2) / ttlMs,
  });
}
```

TTL остаётся равным 24 часам, stale начинается примерно через 4–5 минут. Jitter применяется к интервалу до stale в миллисекундах, а результат переводится в долю TTL. Обновление запускается следующим обращением после `staleAt`, а не таймером. [Подробности механики](docs/flash-cache.md#jitter-момента-stale).

## Redis и форматы хранения

```ts
import Redis from 'ioredis';
import { FlashCache, IORedisStore, MapStore, SerializedStore } from '@bidster/flash-cache';

const redis = new Redis();
const l2 = new SerializedStore<Date, string>(new MapStore<string>(), {
  serialize: (date) => date.toISOString(),
  deserialize: (value) => new Date(value),
});
const dates = new FlashCache(new MapStore<Date>(), l2, { ttl: 60_000, staleRatio: 0.8 });

// Обычные JSON-данные можно хранить в Redis напрямую.
const jsonStore = new IORedisStore(redis);
```

L1 и L2 предоставляют кешу один тип данных. `SerializedStore` адаптирует физическое представление L2; его также можно использовать поверх `IORedisStore` с типом `JsonValue`. `serialize/deserialize` задаются на store, а не в `getOrSet`.

## Клонирование и ошибки

По умолчанию кеш возвращает общую ссылку. Необязательный `cloneValue` в опциях `getOrSet` или `get` создаёт отдельный результат для данного вызова; входящие значения не клонируются. Каждый участник singleflight использует свою функцию. Без опции возвращается общая ссылка независимо от опций других читателей. Настройка на экземпляре удалена. Для совместимых данных можно передать `structuredClone`, для классов — собственную функцию, сохраняющую их поведение.

При ошибке чтения L2 вызывается `onError`. Если повторная проверка не нашла fresh L1, `getOrSet` продолжает через factory, а `get` возвращает `undefined`. Ошибка записи L2 не отменяет успешное получение данных. Обе ошибки сообщаются через `onError`; он также получает ошибки фонового обновления. Причина ошибки внутри L2 не влияет на эту политику: ошибки сериализации обрабатываются так же, как ошибки доступа к хранилищу. Store реализует только `get/set/delete`, без специальных типов ошибок. Ошибки ожидаемой factory, клонирования и удаления L2 передаются вызывающему коду.

```ts
const date = await dates.getOrSet('today', () => new Date(), {
  cloneValue: (value) => new Date(value.getTime()),
});
const copy = await dates.get('today', { cloneValue: (value) => new Date(value.getTime()) });
```

Функция клонирования синхронна и сохраняет тип значения. Её ошибка затрагивает только соответствующего читателя.

## Контракт и разработка

[Подробный контракт](docs/flash-cache.md) · [English](README.md) · [Бенчмарки](bench/README.md)

Основной экспорт — `FlashCache`. Прежние `FlashMemo`, `memoize`, `del`, `useClones`, `materialize`, объект результата `state/revalidation` и временный экспорт `/v2` удалены без обратной совместимости. Префикс хранения — `flashCache:v2:`; `namespace: false` отключает его. Старые ключи v1 не читаются.

```sh
yarn lint
yarn format:check
yarn test
yarn test:types
yarn test:integration
```

`yarn lint:fix` применяет автоматические исправления ESLint, `yarn format` форматирует проект через Prettier. Форматирование кода: 4 пробела, одинарные кавычки, ширина строки 120 символов. Сгенерированные файлы и результаты бенчмарков исключены из форматирования.
