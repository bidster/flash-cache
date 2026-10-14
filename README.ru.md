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

const count = await cache.getOrSet('users', async () => 42);
const hit = cache.getOrSet('users', async () => 100); // 42 синхронно

await cache.set('users', 50, { customTtl: 30_000 });
const stored = await cache.get('users'); // 50 или undefined при промахе
await cache.delete('users');
```

Все операции возвращают `MayBePromise<T>` (`T | Promise<T>`). Свежий L1 читается без Promise и обращения к L2; полностью синхронный промах тоже может завершиться синхронно. `get` не запускает factory и не возвращает объект состояния.

TTL задаётся положительным целым числом миллисекунд. `staleRatio` определяет начало обновления: `0.8` означает, что после 80% TTL значение отдаётся как stale с обновлением в фоне. После полного истечения TTL оно не выдаётся. Перенос L2 → L1 сохраняет исходные сроки жизни. После ответа L2 активная операция повторно проверяет L1: если там уже есть fresh-значение, использует его без перезаписи и без вызова factory. Stale и expired L1 не имеют такого приоритета.

Один singleflight на ключ и экземпляр объединяет чтение L2, factory и запись. `set/delete` отсоединяют старую загрузку: ожидающие читатели получают её результат, но он больше не публикуется в кеше. Уже отправленную запись L2 отменить нельзя; межпроцессной координации нет.

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

По умолчанию кеш возвращает общую ссылку. Необязательный `cloneValue` на экземпляре создаёт отдельный результат для каждого читателя; входящие значения не клонируются. Для совместимых данных можно передать `structuredClone`, для классов — собственную функцию, сохраняющую их поведение.

При ошибке чтения L2 вызывается `onError`. Если повторная проверка не нашла fresh L1, `getOrSet` продолжает через factory, а `get` возвращает `undefined`. Ошибка записи L2 не отменяет успешное получение данных. Обе ошибки сообщаются через `onError`; он также получает ошибки фонового обновления. Причина ошибки внутри L2 не влияет на эту политику: ошибки сериализации обрабатываются так же, как ошибки доступа к хранилищу. Store реализует только `get/set/delete`, без специальных типов ошибок. Ошибки ожидаемой factory, клонирования и удаления L2 передаются вызывающему коду.

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
