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

## Redis и преобразования для конкретного ключа

`FlashCache<T>` задаёт тип значения в L1. Преобразования для L2 передаются как `codec` в опциях `getOrSet`, `get` и `set`; тип промежуточного представления выводится из функций вызова. Дополнительный generic экземпляра и реестр codec не нужны.

```ts
import Redis from 'ioredis';
import { FlashCache, IORedisStore, MapStore } from '@bidster/flash-cache';

const tagsCache = new FlashCache<Set<string>>(new MapStore<Set<string>>(), new IORedisStore(new Redis()), {
  ttl: 60_000,
  staleRatio: 0.8,
});
const codec = {
  serialize: (value: Set<string>) => [...value],
  deserialize: (value: string[]) => new Set(value),
};

const tags = await tagsCache.getOrSet('tags', () => new Set(['typescript']), { codec });
const cached = await tagsCache.get('tags', { codec });
await tagsCache.set('tags', new Set(['updated']), { codec });
```

В L1 хранится `Set`, в записи L2 — массив. `IORedisStore` сам выполняет JSON-сериализацию записи: `JSON.stringify/parse` в codec не нужны. Без преобразования `Set` сериализовался бы как `{}`.

Обе функции codec синхронны и не должны менять исходное значение. Fresh L1 возвращается синхронно без вызова codec. Для singleflight используется codec первого вызова на чтение и запись; остальные читатели получают уже восстановленное значение и могут применить собственный `cloneValue`.

Все обращения к одному ключу должны использовать совместимые преобразования, включая `get/set`. Без codec значение передаётся как есть: вызывающий код отвечает за совместимость с L2. Чтение закодированного ключа без codec может работать на L1, но вернуть неправильный тип из L2. Codec не запоминается и не сравнивается по ссылке. `SerializedStore` удалён; подключайте L2 напрямую.

## Обёртки Redis-команд

Наследник `IORedisStore` может переопределить protected-методы `read(key)`, `write(key, raw, expAt)` и `remove(key)`, обернув вызовы `super` в circuit breaker или другую политику выполнения. Публичные `get/set/delete` сохраняют JSON-преобразования и абсолютный срок истечения через `PXAT`. Сериализация выполняется до `write`, разбор JSON — после завершения `read`, поэтому ошибки JSON остаются за пределами обёртки команд. [Пример наследника](docs/flash-cache.md#обёртки-redis-команд).

## Клонирование и ошибки

По умолчанию кеш возвращает общую ссылку. Необязательный `cloneValue` в опциях `getOrSet` или `get` создаёт отдельный результат для данного вызова; входящие значения не клонируются. Каждый участник singleflight использует свою функцию. Без опции возвращается общая ссылка независимо от опций других читателей. Настройка на экземпляре удалена. Для совместимых данных можно передать `structuredClone`, для классов — собственную функцию, сохраняющую их поведение.

При ошибке чтения L2 вызывается `onError`. Если повторная проверка не нашла fresh L1, `getOrSet` продолжает через factory, а `get` возвращает `undefined`. Ошибка записи L2 не отменяет успешное получение данных. Обе ошибки сообщаются через `onError`; он также получает ошибки фонового обновления. Причина ошибки внутри L2 не влияет на эту политику: ошибки сериализации обрабатываются так же, как ошибки доступа к хранилищу. Store реализует только `get/set/delete`, без специальных типов ошибок. Ошибки ожидаемой factory, клонирования и удаления L2 передаются вызывающему коду.

```ts
const copy = await tagsCache.get('tags', {
  codec,
  cloneValue: (value) => new Set(value),
});
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
