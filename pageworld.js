// Runs in the PAGE'S MAIN WORLD on character_edit.php (manifest
// content_scripts entry with "world": "MAIN"). This file has direct
// access to F-list's own globals — uploadImage, deleteImage, FList.* —
// which the isolated-world content.js cannot reach. F-list's CSP
// forbids inline <script> tags, so dynamic <script> injection from
// the isolated world silently no-ops. Bridging via window.postMessage
// works regardless of CSP because no string-to-code evaluation happens.
//
// The isolated content.js sends:
//   window.postMessage({ type: 'flist-wb-rpc', id, action, args }, '*')
// We respond with:
//   window.postMessage({ type: 'flist-wb-rpc-result', id, ok, error? }, '*')

(() => {
  'use strict';

  function handle(action, args) {
    switch (action) {
      case 'uploadImage':
        if (typeof window.uploadImage === 'function') {
          window.uploadImage();
          return { ok: true };
        }
        return { ok: false, error: 'uploadImage not on page' };

      case 'uploadAvatar':
        // F-list's avatar upload path varies. Common entry points:
        // window.uploadAvatar, window.submitAvatar, or just relying on
        // the file input change event. Try a few.
        if (typeof window.uploadAvatar === 'function') {
          window.uploadAvatar();
          return { ok: true };
        }
        if (typeof window.submitAvatar === 'function') {
          window.submitAvatar();
          return { ok: true };
        }
        return { ok: true, note: 'no upload function found; file input set, page will pick up on Save' };

      case 'deleteImage':
        if (typeof window.deleteImage === 'function') {
          window.deleteImage(String(args.id));
          return { ok: true };
        }
        return { ok: false, error: 'deleteImage not on page' };

      case 'addCustomKink':
        if (window.FList && typeof window.FList.CharEditor_addKink === 'function') {
          window.FList.CharEditor_addKink();
          return { ok: true };
        }
        return { ok: false, error: 'FList.CharEditor_addKink not available' };

      case 'removeCustomKink':
        if (
          window.FList &&
          window.FList.Subfetish &&
          window.FList.Subfetish.Data &&
          typeof window.FList.Subfetish.Data.removeCustom === 'function'
        ) {
          window.FList.Subfetish.Data.removeCustom(String(args.id));
          return { ok: true };
        }
        return { ok: false, error: 'FList.Subfetish.Data.removeCustom not available' };

      case 'jqueryRemove':
        // Custom-kink container removal — F-list's UI is jQuery-driven
        // so $('#x').remove() also fires teardown handlers a bare
        // .remove() on a DOM node would skip.
        if (window.$ && typeof window.$ === 'function') {
          try { window.$('#' + args.selector).remove(); return { ok: true }; }
          catch (e) { return { ok: false, error: String(e && e.message || e) }; }
        }
        try {
          const node = document.getElementById(args.selector);
          if (node) node.remove();
          return { ok: true };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'setSelectVal':
        // F-list wraps infotag selects with Select2-style widgets. Native
        // `.value = x` updates the underlying <select> but the visible
        // widget stays on the old option. jQuery's `.val(x).trigger('change')`
        // updates both. Fall back to native if jQuery isn't loaded.
        try {
          if (window.$ && typeof window.$ === 'function') {
            const $el = window.$('[name="' + args.name.replace(/"/g, '\\"') + '"]');
            $el.val(args.value);
            $el.trigger('change');
            return { ok: true };
          }
          const el = document.querySelector('[name="' + args.name.replace(/"/g, '\\"') + '"]');
          if (el) {
            el.value = args.value;
            el.dispatchEvent(new Event('change', { bubbles: true }));
            return { ok: true };
          }
          return { ok: false, error: 'select not found: ' + args.name };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'setCustomKinkRows':
        // Populate the N most-recently-added customkink rows from a
        // payload [{name, description, choice}, ...]. Runs in page world
        // so jQuery-bound select widgets pick up the change event.
        try {
          const form = document.getElementById('CharacterForm');
          if (!form) return { ok: false, error: 'CharacterForm missing' };
          const ns = form.querySelectorAll('[name="customkinkname[]"]');
          const ds = form.querySelectorAll('[name="customkinkdescription[]"]');
          const cs = form.querySelectorAll('[name="customkinkchoice[]"]');
          const rows = args.rows || [];
          rows.forEach((row, i) => {
            const idx = i; // rows[0] → first input, etc.
            if (ns[idx]) {
              ns[idx].value = row.name || '';
              ns[idx].dispatchEvent(new Event('input', { bubbles: true }));
              ns[idx].dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (ds[idx]) {
              ds[idx].value = row.description || '';
              ds[idx].dispatchEvent(new Event('input', { bubbles: true }));
            }
            if (cs[idx]) {
              if (window.$ && typeof window.$ === 'function') {
                window.$(cs[idx]).val(row.choice || 'undecided').trigger('change');
              } else {
                cs[idx].value = row.choice || 'undecided';
                cs[idx].dispatchEvent(new Event('change', { bubbles: true }));
              }
            }
          });
          return { ok: true, filled: rows.length };
        } catch (e) {
          return { ok: false, error: String(e && e.message || e) };
        }

      case 'ping':
        return { ok: true, world: 'main' };

      default:
        return { ok: false, error: 'unknown action ' + action };
    }
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || m.type !== 'flist-wb-rpc') return;
    let res;
    try { res = handle(m.action, m.args || {}); }
    catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    window.postMessage({
      type: 'flist-wb-rpc-result',
      id: m.id,
      ok: !!res.ok,
      error: res.error || null,
      note: res.note || null,
    }, '*');
  });

  // Hello-handshake so the isolated world can detect that the page-world
  // bridge is present without round-tripping a real RPC.
  window.postMessage({ type: 'flist-wb-rpc-ready' }, '*');
})();
