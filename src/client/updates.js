// Keeps the app current. The service worker (sw.js) installs a new version by itself, but the page that is already
// open keeps running the old code, so without this you would only see an update on the launch after the next one.
// We look for a new version when the app opens, when it comes back to the foreground and once an hour, and reload
// into it as soon as it takes over (never in the middle of a game: see `tryReload`).

export const CHECK_EVERY_MS = 60 * 60 * 1000;
/** Never reload twice within this long, so a misbehaving worker cannot trap the page in a reload loop. */
export const RELOAD_GUARD_MS = 15000;

/**
 * @param {object} o
 * @param {ServiceWorkerContainer} o.sw        navigator.serviceWorker
 * @param {() => boolean} o.canReloadNow       true when a reload would not interrupt anything (title screen)
 * @param {() => void} o.reload                location.reload
 * @param {{get: () => number, set: (t: number) => void}} o.loopGuard  remembers the last reload time across reloads
 * @param {string} [o.url]
 * @param {() => number} [o.now]
 * @param {(fn: () => void, ms: number) => any} [o.every]
 * @param {(fn: () => void, ms: number) => any} [o.later]
 */
export function registerWithUpdates({ sw, canReloadNow, reload, loopGuard, url = 'sw.js', now = Date.now, every = setInterval, later = setTimeout, onError = () => {} }) {
  let controlled = !!sw.controller; // false on the very first visit: the worker claiming the page is not an update
  let reg = null;
  let pending = false;

  /** Reload into the new version if one has taken over. `force` skips the "not mid-game" rule (the caller has saved). */
  function tryReload(force = false) {
    if (!pending || (!force && !canReloadNow())) return false;
    const last = loopGuard.get();
    if (last && now() - last < RELOAD_GUARD_MS) {
      later(() => tryReload(force), RELOAD_GUARD_MS - (now() - last) + 50); // not dropped: try again once the window is over
      return false;
    }
    loopGuard.set(now());
    pending = false;
    reload();
    return true;
  }

  function checkNow() {
    if (!reg) return Promise.resolve();
    return Promise.resolve(reg.update()).catch(() => { /* offline: try again next time */ });
  }

  sw.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    pending = true;
    tryReload();
  });

  // A worker that is still installing (first visit, or a fresh version already found) is the newest there is: asking
  // again would only queue a second job behind it, and Chrome can leave that queue stuck for a minute.
  sw.register(url, { updateViaCache: 'none' }).then((r) => { reg = r; return r.installing ? undefined : checkNow(); }, onError);
  every(checkNow, CHECK_EVERY_MS);

  return { checkNow, tryReload, get pending() { return pending; } };
}
