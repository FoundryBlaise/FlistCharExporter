(() => {
  'use strict';

  const LOG_PREFIX = '[F-list Workbench]';
  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const err = (...args) => console.error(LOG_PREFIX, ...args);

  function getCharacterName() {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get('character');
    if (fromUrl) return fromUrl;
    const heading = document.querySelector('h2')?.textContent || '';
    return heading.replace(/^Editing\s+/, '').trim() || null;
  }

  function sendBg(message) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: 'runtime', detail: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false, error: 'no_response' });
        }
      });
    });
  }

  function makeEl(tag, props = {}, children = []) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else if (k === 'html') el.innerHTML = v;
      else el.setAttribute(k, v);
    }
    children.forEach((c) => el.appendChild(c));
    return el;
  }

  function openModal({ title, body, footer }) {
    const overlay = makeEl('div', { class: 'flist-wb-overlay' });
    const modal = makeEl('div', { class: 'flist-wb-modal' });

    const header = makeEl('div', { class: 'flist-wb-modal-header' });
    header.appendChild(makeEl('div', { class: 'flist-wb-modal-title', text: title }));
    const close = makeEl('button', { class: 'flist-wb-modal-close', text: '×' });
    close.addEventListener('click', () => overlay.remove());
    header.appendChild(close);

    const bodyEl = makeEl('div', { class: 'flist-wb-modal-body' });
    if (typeof body === 'string') bodyEl.innerHTML = body;
    else if (body) bodyEl.appendChild(body);

    const footerEl = makeEl('div', { class: 'flist-wb-modal-footer' });
    if (footer) (Array.isArray(footer) ? footer : [footer]).forEach((b) => footerEl.appendChild(b));

    modal.appendChild(header);
    modal.appendChild(bodyEl);
    modal.appendChild(footerEl);
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') {
        overlay.remove();
        document.removeEventListener('keydown', esc);
      }
    });

    return { overlay, modal, body: bodyEl, footer: footerEl, close: () => overlay.remove() };
  }

  function toast({ title, message, kind = 'info', durationMs = 5000 }) {
    const el = makeEl('div', { class: `flist-wb-toast ${kind}` });
    if (title) el.appendChild(makeEl('div', { class: 'flist-wb-toast-title', text: title }));
    el.appendChild(makeEl('div', { text: message }));
    document.body.appendChild(el);
    if (durationMs > 0) setTimeout(() => el.remove(), durationMs);
    return el;
  }

  function extractImageData() {
    const images = [];
    document.querySelectorAll('.character_image').forEach((container) => {
      const preview = container.querySelector('.character_image_preview');
      const desc = container.querySelector('.character_image_description');
      const style = preview?.style.backgroundImage || '';
      const match = style.match(/url\(["']?(.*?)["']?\)/);
      const thumbUrl = match ? match[1] : null;
      const imageId = container.id.replace('image', '');
      if (thumbUrl && imageId) {
        images.push({
          id: imageId,
          thumbUrl,
          fullUrl: thumbUrl.replace('/charthumb/', '/charimage/'),
          description: desc?.value || '',
        });
      }
    });
    const avatarImg = document.querySelector('img[src*="/images/avatar/"]');
    return { images, avatar: avatarImg?.src || null };
  }

  function extractCharacterFormState() {
    const form = document.getElementById('CharacterForm');
    if (!form) throw new Error('Character form not found on page');

    const data = {
      meta: { extractedAt: new Date().toISOString(), source: 'extension' },
      character: {
        id: form.querySelector('[name="character_id"]')?.value || null,
        name: getCharacterName(),
        description: form.querySelector('[name="description"]')?.value || '',
        customTitle: form.querySelector('[name="custom_title"]')?.value || '',
      },
      settings: {},
      infotags: {},
      kinks: {},
      customKinks: [],
    };

    ['public', 'showtimezone', 'unbookmarkable', 'showbadges',
     'showfriends', 'customsfirst', 'moderate', 'showcharlist'].forEach((name) => {
      const el = form.querySelector(`[name="${name}"]`);
      if (el) data.settings[name] = el.type === 'checkbox' ? el.checked : el.value;
    });

    form.querySelectorAll('[name^="info_"]').forEach((el) => {
      if (el.value) data.infotags[el.name] = el.value;
    });

    form.querySelectorAll('[name^="fetish_"]').forEach((el) => {
      data.kinks[el.name] = el.value;
    });

    const names = form.querySelectorAll('[name="customkinkname[]"]');
    const descs = form.querySelectorAll('[name="customkinkdescription[]"]');
    const choices = form.querySelectorAll('[name="customkinkchoice[]"]');
    const ids = form.querySelectorAll('[name="customkinkid[]"]');
    for (let i = 0; i < names.length; i++) {
      if (names[i].value) {
        data.customKinks.push({
          id: ids[i]?.value || null,
          name: names[i].value,
          description: descs[i]?.value || '',
          choice: choices[i]?.value || '',
        });
      }
    }
    return data;
  }

  function fireChange(el) {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function setTextFieldValue(el, value) {
    el.value = value;
    fireChange(el);
  }

  function setCheckboxValue(el, value) {
    el.checked = !!value;
    fireChange(el);
  }

  // Selects are the tricky case: F-list overlays Select2 (or similar)
  // widgets on infotag and kink dropdowns, so changing .value natively
  // updates the underlying <select> but the visible widget keeps the
  // old label. We route through pageworld.js which calls
  // $(sel).val(x).trigger('change') — that updates both layers.
  async function setSelectValue(el, value) {
    el.value = value;
    fireChange(el);
    if (el.name) await callPage('setSelectVal', { name: el.name, value: String(value) }, 4_000);
  }

  async function applyCharacterData(data) {
    const form = document.getElementById('CharacterForm');
    if (!form) throw new Error('Character form not found on page');

    const result = { fields: 0, kinks: 0, customKinks: 0, warnings: [] };

    const desc = form.querySelector('[name="description"]');
    if (desc) { setTextFieldValue(desc, data.character?.description || ''); result.fields++; }
    const title = form.querySelector('[name="custom_title"]');
    if (title) { setTextFieldValue(title, data.character?.customTitle || ''); result.fields++; }

    if (data.settings) {
      for (const [name, value] of Object.entries(data.settings)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) continue;
        if (el.type === 'checkbox') setCheckboxValue(el, value);
        else if (el.tagName === 'SELECT') await setSelectValue(el, value);
        else setTextFieldValue(el, value);
        result.fields++;
      }
    }

    if (data.infotags && Object.keys(data.infotags).length > 0) {
      for (const [name, value] of Object.entries(data.infotags)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) continue;
        if (el.tagName === 'SELECT') await setSelectValue(el, value);
        else setTextFieldValue(el, value);
        result.fields++;
      }
    }

    if (data.kinks && Object.keys(data.kinks).length > 0) {
      for (const [name, value] of Object.entries(data.kinks)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) continue;
        if (el.tagName === 'SELECT') await setSelectValue(el, value);
        else setTextFieldValue(el, value);
        result.kinks++;
      }
    }

    // Custom kinks: clear existing via page-world (so FList teardown +
    // jQuery handlers fire), add the new ones via FList.CharEditor_addKink,
    // then fill via page-world to pick up Select2 widgets on the choice
    // dropdown.
    const existingContainers = document.querySelectorAll(
      '[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"])'
    );
    for (const container of existingContainers) {
      const match = container.id.match(/CustomKink(\d+)/);
      if (!match) continue;
      await callPage('jqueryRemove', { selector: container.id });
      await callPage('removeCustomKink', { id: match[1] });
    }

    const customKinks = data.customKinks || [];
    if (customKinks.length > 0) {
      for (let i = 0; i < customKinks.length; i++) {
        await callPage('addCustomKink');
      }
      // Brief settle so the page DOM reflects the new rows before we fill.
      await new Promise((r) => setTimeout(r, 200));
      await callPage('setCustomKinkRows', { rows: customKinks }, 8_000);
      result.customKinks = customKinks.length;
    }

    return result;
  }

  // RPC bridge to pageworld.js (manifest "world": "MAIN"). F-list's CSP
  // forbids inline <script> tags so direct text-injection silently
  // no-ops; extension content scripts with explicit world="MAIN" are
  // exempt from page CSP because they're extension code. Bridge is
  // window.postMessage with a small request/response protocol.
  let bridgeReady = false;
  let bridgeReadyResolvers = [];
  let rpcCounter = 0;
  const rpcPending = new Map();

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'flist-wb-rpc-ready') {
      bridgeReady = true;
      const resolvers = bridgeReadyResolvers;
      bridgeReadyResolvers = [];
      resolvers.forEach((r) => r());
      return;
    }
    if (m.type === 'flist-wb-rpc-result') {
      const pending = rpcPending.get(m.id);
      if (pending) {
        rpcPending.delete(m.id);
        pending(m);
      }
    }
  });

  function waitForBridge(timeoutMs = 4000) {
    if (bridgeReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        bridgeReadyResolvers = bridgeReadyResolvers.filter((r) => r !== onReady);
        resolve(false);
      }, timeoutMs);
      const onReady = () => { clearTimeout(timer); resolve(true); };
      bridgeReadyResolvers.push(onReady);
    });
  }

  function callPage(action, args = {}, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const id = ++rpcCounter;
      const timer = setTimeout(() => {
        if (rpcPending.has(id)) {
          rpcPending.delete(id);
          resolve({ ok: false, error: 'rpc_timeout', action });
        }
      }, timeoutMs);
      rpcPending.set(id, (msg) => {
        clearTimeout(timer);
        resolve({ ok: msg.ok, error: msg.error, note: msg.note });
      });
      window.postMessage({ type: 'flist-wb-rpc', id, action, args }, '*');
    });
  }

  async function uploadSingleImage(bytes, filename) {
    const fileInput = document.getElementById('imagefile');
    if (!fileInput) throw new Error('Image file input not found');

    const beforeCount = document.querySelectorAll('.character_image').length;
    const mime = filename.endsWith('.png') ? 'image/png'
               : filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
    const file = new File([new Blob([bytes], { type: mime })], filename, { type: mime });
    const dt = new DataTransfer();
    dt.items.add(file);
    fileInput.files = dt.files;

    const callPromise = callPage('uploadImage', {}, 30_000);

    return new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        const after = document.querySelectorAll('.character_image').length;
        if (after > beforeCount) {
          clearInterval(interval);
          const containers = document.querySelectorAll('.character_image');
          resolve(containers[containers.length - 1]?.id?.replace('image', '') || null);
        } else if (attempts >= 60) {
          clearInterval(interval);
          callPromise.then((r) => reject(new Error('Upload timeout' + (r && r.error ? ' (' + r.error + ')' : ''))));
        }
      }, 500);
    });
  }

  function uploadAvatarBytes(bytes, filename) {
    return new Promise((resolve, reject) => {
      const fileInput = document.getElementById('avatar-file');
      if (!fileInput) return reject(new Error('Avatar file input not found'));
      const mime = filename.endsWith('.png') ? 'image/png'
                 : filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
      const file = new File([new Blob([bytes], { type: mime })], filename, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
      resolve(true);
    });
  }

  function deleteImageById(imageId) {
    const callPromise = callPage('deleteImage', { id: String(imageId) }, 15_000);
    return new Promise((resolve, reject) => {
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (!document.getElementById(`image${imageId}`)) {
          clearInterval(interval);
          resolve();
        } else if (attempts >= 30) {
          clearInterval(interval);
          callPromise.then((r) => reject(new Error('Delete timeout' + (r && r.error ? ' (' + r.error + ')' : ''))));
        }
      }, 500);
    });
  }

  // Content-script-direct sidecar calls. Going through the service
  // worker would force chrome.runtime.sendMessage to serialise the ZIP
  // bytes as a JSON array, which both inflates ~4x and hits Chrome's
  // 64 MiB IPC ceiling. Direct fetch is cross-origin (page is on
  // f-list.net, sidecar on 127.0.0.1) but the sidecar's CORS middleware
  // is allow-all, so the response lands cleanly as an ArrayBuffer.
  const SIDECAR_BASE = 'http://127.0.0.1:8765';

  async function getStoredToken() {
    try {
      const { workbench_token } = await chrome.storage.local.get('workbench_token');
      return workbench_token || null;
    } catch {
      return null;
    }
  }

  async function sidecarGet(path) {
    const token = await getStoredToken();
    if (!token) return { ok: false, error: 'not_paired', status: 401 };
    try {
      const res = await fetch(SIDECAR_BASE + path, {
        headers: { 'X-Workbench-Auth': token },
      });
      return res;
    } catch (e) {
      return { ok: false, error: 'unreachable', detail: String(e) };
    }
  }

  async function snapshotsList(character) {
    const res = await sidecarGet('/restore/snapshots?character=' + encodeURIComponent(character));
    if (res.ok === false) return res;
    if (res.status === 401) return { ok: false, error: 'not_paired', status: 401 };
    if (!res.ok) return { ok: false, error: 'list_failed', status: res.status };
    return { ok: true, snapshots: await res.json() };
  }

  async function snapshotZipBytes(character, snapshotId) {
    const res = await sidecarGet(
      '/restore/snapshot/' + encodeURIComponent(snapshotId) +
        '?character=' + encodeURIComponent(character)
    );
    if (res.ok === false) return res;
    if (!res.ok) return { ok: false, error: 'fetch_failed', status: res.status };
    const buf = await res.arrayBuffer();
    return { ok: true, bytes: new Uint8Array(buf) };
  }

  async function archivedCharactersList() {
    const res = await sidecarGet('/restore/characters');
    if (res.ok === false) return res;
    if (!res.ok) return { ok: false, error: 'list_chars_failed', status: res.status };
    return { ok: true, characters: await res.json() };
  }

  // image_id resolution for backup entries: sidecar working-set ZIPs
  // emit only {position, filename, description}, where filename is
  // `images/<image_id>.<ext>`. Userscript-format exports may also have
  // image_id / id on the entry directly. Try both, parse from
  // filename last.
  function backupEntryImageId(entry) {
    if (!entry || typeof entry !== 'object') return '';
    if (entry.image_id) return String(entry.image_id);
    if (entry.id) return String(entry.id);
    const fn = entry.filename;
    if (typeof fn === 'string') {
      const base = fn.split('/').pop() || '';
      const dot = base.lastIndexOf('.');
      if (dot > 0) return base.slice(0, dot);
      return base;
    }
    return '';
  }

  function diffImageSets(currentImages, backupImageList) {
    const currentIds = new Set(currentImages.map((i) => i.id));
    const backupIds = new Set((backupImageList || []).map(backupEntryImageId).filter(Boolean));
    const willDelete = currentImages.filter((i) => !backupIds.has(i.id));
    const willAdd = (backupImageList || []).filter((b) => {
      const id = backupEntryImageId(b);
      return !id || !currentIds.has(id);
    });
    return { willDelete, willAdd };
  }

  function fmtRelative(iso) {
    if (!iso) return 'unknown';
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return iso;
    const diff = (Date.now() - t) / 1000;
    if (diff < 60) return `${Math.round(diff)}s ago`;
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
  }

  async function showSafetyScreen({ data, source, character, lastBackupIso, applyFn }) {
    const current = extractImageData();
    const backupImages = data?.images?.list || [];
    const { willDelete, willAdd } = diffImageSets(current.images, backupImages);

    const body = makeEl('div');

    body.appendChild(makeEl('div', {
      class: 'flist-wb-info-box',
      html: `
        <div><strong>Restoring into:</strong> ${escapeHtml(character || 'unknown character')}</div>
        <div><strong>Source:</strong> ${escapeHtml(source)}</div>
        <div><strong>Last backup:</strong> ${lastBackupIso ? escapeHtml(fmtRelative(lastBackupIso)) : '<em>none on record</em>'}</div>
      `,
    }));

    body.appendChild(makeEl('div', {
      class: 'flist-wb-info-box',
      html: `
        <strong>Form fields</strong> (description, kinks, infotags, settings, custom kinks)
        are filled into the page and <strong>only persist when YOU click F-list's Save button</strong>.
        You can review every field before saving.
      `,
    }));

    if (willDelete.length > 0 || willAdd.length > 0) {
      body.appendChild(makeEl('div', {
        class: 'flist-wb-warn-box',
        html: `
          <strong>⚠ Image changes are destructive and happen IMMEDIATELY</strong> on Apply
          — F-list's image API does not wait for Save.
          <ul style="margin: 8px 0 4px 18px; padding: 0;">
            ${willDelete.length > 0
              ? `<li><strong>${willDelete.length}</strong> image(s) currently on F-list will be <strong>deleted</strong> (IDs: ${willDelete.map((i) => i.id).join(', ')})</li>`
              : ''}
            ${willAdd.length > 0 ? `<li><strong>${willAdd.length}</strong> image(s) from the backup will be uploaded</li>` : ''}
          </ul>
          This cannot be undone unless you have a fresh backup.
        `,
      }));
    } else {
      body.appendChild(makeEl('div', {
        class: 'flist-wb-info-box',
        text: 'No image changes — gallery already matches the backup.',
      }));
    }

    const skipImages = makeEl('label', { class: 'flist-wb-confirm-row' });
    const skipImagesCb = makeEl('input', { type: 'checkbox', id: 'flist-wb-skip-images' });
    skipImages.appendChild(skipImagesCb);
    skipImages.appendChild(makeEl('span', { text: 'Skip image changes (only fill form fields)' }));
    body.appendChild(skipImages);

    const confirmRow = makeEl('label', { class: 'flist-wb-confirm-row' });
    const confirmCb = makeEl('input', { type: 'checkbox', id: 'flist-wb-confirm-destructive' });
    confirmRow.appendChild(confirmCb);
    confirmRow.appendChild(makeEl('span', { text: 'I understand image deletions/uploads happen instantly on F-list.' }));
    body.appendChild(confirmRow);

    const backupFirstBtn = makeEl('button', {
      class: 'flist-wb-btn secondary',
      text: 'Back up current state first',
    });
    const cancelBtn = makeEl('button', { class: 'flist-wb-btn secondary', text: 'Cancel' });
    const applyBtn = makeEl('button', { class: 'flist-wb-btn', text: 'Apply restore' });
    applyBtn.disabled = (willDelete.length > 0 || willAdd.length > 0);

    const updateApplyState = () => {
      const needsConfirm = !skipImagesCb.checked && (willDelete.length > 0 || willAdd.length > 0);
      applyBtn.disabled = needsConfirm && !confirmCb.checked;
    };
    skipImagesCb.addEventListener('change', updateApplyState);
    confirmCb.addEventListener('change', updateApplyState);
    updateApplyState();

    const modal = openModal({
      title: 'Confirm restore',
      body,
      footer: [backupFirstBtn, cancelBtn, applyBtn],
    });

    cancelBtn.addEventListener('click', () => modal.close());

    backupFirstBtn.addEventListener('click', async () => {
      backupFirstBtn.disabled = true;
      backupFirstBtn.textContent = 'Backing up form state…';
      const payload = extractCharacterFormState();
      const res = await sendBg({ type: 'snapshot_form_state', character, payload });
      if (!res.ok) {
        backupFirstBtn.disabled = false;
        backupFirstBtn.textContent = 'Back up current state first';
        toast({ title: 'Backup failed', message: explainError(res), kind: 'error' });
        return;
      }
      backupFirstBtn.textContent = `✓ Backed up (form fields only — images not included)`;
      toast({
        title: 'Backed up',
        message: 'Current form state stored in Workbench. Image bytes not included in this v1 backup.',
        kind: 'success',
      });
    });

    applyBtn.addEventListener('click', async () => {
      modal.close();
      try {
        await applyFn({ skipImages: skipImagesCb.checked });
      } catch (e) {
        err(e);
        toast({ title: 'Restore failed', message: String(e.message || e), kind: 'error' });
      }
    });
  }

  function escapeHtml(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function explainError(res) {
    if (!res) return 'No response.';
    if (res.error === 'unreachable') return 'Workbench sidecar is not reachable on 127.0.0.1:8765. Is Workbench running?';
    if (res.error === 'not_paired') return 'Extension is not paired with Workbench yet. Click the extension icon to pair.';
    if (res.status === 401) return 'Pairing token rejected. Re-pair the extension via Workbench Settings → Security.';
    return `${res.error || 'Unknown error'}${res.detail ? ': ' + res.detail : ''}`;
  }

  function findSaveButtons() {
    // Scan the whole document — F-list may have buttons outside the
    // CharacterForm element. Match anything that's structurally a
    // submit button OR has text suggesting it saves the profile.
    const candidates = new Set(
      document.querySelectorAll(
        'input[type="submit"], button[type="submit"], button:not([type])'
      )
    );
    document.querySelectorAll('button, input[type="button"]').forEach((b) => {
      const text = ((b.value || '') + ' ' + (b.textContent || '')).trim().toLowerCase();
      if (
        text.includes('update character') ||
        text.includes('save changes') ||
        text === 'save'
      ) {
        candidates.add(b);
      }
    });
    return Array.from(candidates);
  }

  function isInsideOurUi(target) {
    if (!target || !target.closest) return false;
    return !!target.closest(
      '#flist-wb-bar, .flist-wb-overlay, .flist-wb-toast, .flist-wb-save-notice'
    );
  }

  // Belt-and-braces save-blocking. `disabled` alone is insufficient
  // because F-list may submit via:
  //   - a JS onclick handler that calls form.submit() (bypasses disabled
  //     and doesn't fire the submit event)
  //   - a button labelled "Update Character" that isn't structurally a
  //     submit input
  //   - Enter pressed in any form input
  // So we intercept click / submit / Enter at the capture phase, on the
  // document, and drop them unless they target our own UI.
  function lockSaveButtons(reason) {
    const saves = findSaveButtons();
    const prior = saves.map((b) => ({
      el: b,
      disabled: b.disabled,
      title: b.getAttribute('title'),
    }));
    saves.forEach((b) => {
      b.disabled = true;
      b.classList.add('flist-wb-save-locked');
      b.setAttribute('title', reason);
    });

    const notices = [];
    saves.forEach((b) => {
      if (b.parentNode) {
        const notice = makeEl('div', { class: 'flist-wb-save-notice', text: reason });
        b.parentNode.insertBefore(notice, b);
        notices.push(notice);
      }
    });

    const blockClick = (e) => {
      if (isInsideOurUi(e.target)) return;
      const t = e.target.closest && e.target.closest(
        'input[type="submit"], button[type="submit"], button:not([type]), button, input[type="button"]'
      );
      if (!t) return;
      if (!saves.includes(t)) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      e.stopPropagation();
      toast({ title: 'Wait', message: reason, kind: 'warn', durationMs: 3000 });
    };

    const blockSubmit = (e) => {
      if (isInsideOurUi(e.target)) return;
      const form = e.target;
      if (form && form.id === 'CharacterForm') {
        e.preventDefault();
        e.stopImmediatePropagation();
        e.stopPropagation();
        toast({ title: 'Wait', message: reason, kind: 'warn', durationMs: 3000 });
      }
    };

    const blockEnter = (e) => {
      if (e.key !== 'Enter') return;
      if (isInsideOurUi(e.target)) return;
      if (!e.target.closest || !e.target.closest('#CharacterForm')) return;
      // Allow Enter inside textareas (BBCode editing) — they don't
      // submit the form anyway.
      if (e.target.tagName === 'TEXTAREA') return;
      e.preventDefault();
      e.stopImmediatePropagation();
    };

    document.addEventListener('click', blockClick, { capture: true });
    document.addEventListener('submit', blockSubmit, { capture: true });
    document.addEventListener('keydown', blockEnter, { capture: true });

    return () => {
      document.removeEventListener('click', blockClick, { capture: true });
      document.removeEventListener('submit', blockSubmit, { capture: true });
      document.removeEventListener('keydown', blockEnter, { capture: true });
      prior.forEach(({ el, disabled, title }) => {
        el.disabled = disabled;
        el.classList.remove('flist-wb-save-locked');
        if (title === null) el.removeAttribute('title');
        else el.setAttribute('title', title);
      });
      notices.forEach((n) => n.remove());
    };
  }

  function enterBarProgressMode() {
    const bar = document.getElementById('flist-wb-bar');
    if (!bar) {
      // Standalone mode (e.g. on a stub page) — just return inert helpers.
      return {
        update: () => {},
        setRatio: () => {},
        restore: () => {},
        onCancel: () => {},
      };
    }
    const childSnapshot = Array.from(bar.children);
    childSnapshot.forEach((c) => (c.style.display = 'none'));

    const label = makeEl('span', { class: 'flist-wb-bar-label', text: 'F-list Workbench' });
    const status = makeEl('span', { class: 'flist-wb-progress-status', text: 'Applying restore…' });
    const bar1 = makeEl('div', { class: 'flist-wb-progress-bar' });
    const fill = makeEl('div', { class: 'flist-wb-progress-fill' });
    bar1.appendChild(fill);
    const cancelBtn = makeEl('button', { class: 'flist-wb-btn danger', type: 'button', text: 'Cancel' });

    bar.appendChild(label);
    bar.appendChild(status);
    bar.appendChild(bar1);
    bar.appendChild(cancelBtn);

    let cancelHandler = null;
    cancelBtn.addEventListener('click', () => {
      if (cancelHandler) cancelHandler();
      cancelBtn.disabled = true;
      cancelBtn.textContent = 'Cancelling…';
    });

    return {
      update: (text) => { status.textContent = text; },
      setRatio: (n) => {
        const pct = Math.max(0, Math.min(1, n)) * 100;
        fill.style.width = pct.toFixed(1) + '%';
      },
      onCancel: (fn) => { cancelHandler = fn; },
      restore: () => {
        [label, status, bar1, cancelBtn].forEach((el) => el.remove());
        childSnapshot.forEach((c) => (c.style.display = ''));
      },
    };
  }

  async function doApply(zip, data, { skipImages }) {
    const cancelToken = { cancelled: false };
    const progress = enterBarProgressMode();
    progress.onCancel(() => { cancelToken.cancelled = true; });
    const unlockSave = lockSaveButtons('Workbench is restoring images. Save re-enables when finished.');

    let outcome = 'completed';
    let counts = { deleted: 0, uploaded: 0, deletePlanned: 0, uploadPlanned: 0 };
    let result = { fields: 0, kinks: 0, customKinks: 0, warnings: [] };

    try {
      progress.update('Filling form fields…');
      progress.setRatio(0);
      result = await applyCharacterData(data);

      if (!skipImages) {
        const current = extractImageData();
        const backupImages = data?.images?.list || [];
        const { willDelete } = diffImageSets(current.images, backupImages);
        counts.deletePlanned = willDelete.length;

        for (let i = 0; i < willDelete.length; i++) {
          if (cancelToken.cancelled) { outcome = 'cancelled'; break; }
          progress.update(`Deleting image ${i + 1}/${willDelete.length}`);
          progress.setRatio(i / Math.max(1, willDelete.length + 1 + backupImages.length));
          try {
            await deleteImageById(willDelete[i].id);
            counts.deleted++;
          } catch (e) { warn('delete failed', willDelete[i].id, e); }
        }

        if (outcome !== 'cancelled' && data?.images?.avatar?.filename) {
          const avatarFile = zip ? zip.file(data.images.avatar.filename) : null;
          if (avatarFile) {
            progress.update('Uploading avatar…');
            try {
              const bytes = await avatarFile.async('uint8array');
              await uploadAvatarBytes(bytes, data.images.avatar.filename.split('/').pop());
            } catch (e) { warn('avatar upload failed', e); }
          }
        }

        if (outcome !== 'cancelled') {
          const { willAdd: toUpload } = diffImageSets(extractImageData().images, backupImages);
          counts.uploadPlanned = toUpload.length;
          if (zip && toUpload.length > 0) {
            for (let i = toUpload.length - 1; i >= 0; i--) {
              if (cancelToken.cancelled) { outcome = 'cancelled'; break; }
              const meta = toUpload[i];
              const idx = toUpload.length - i;
              progress.update(`Uploading image ${idx}/${toUpload.length}`);
              const denom = Math.max(1, counts.deletePlanned + 1 + toUpload.length);
              progress.setRatio((counts.deletePlanned + idx) / denom);
              const file = zip.file(meta.filename);
              if (!file) continue;
              try {
                const bytes = await file.async('uint8array');
                const filename = meta.filename.split('/').pop();
                const newId = await uploadSingleImage(bytes, filename);
                counts.uploaded++;
                if (meta.description && newId) {
                  const descInput = document.querySelector(`#image${newId} .character_image_description`);
                  if (descInput) descInput.value = meta.description;
                }
              } catch (e) { warn('image upload failed', meta.filename, e); }
            }
          }
        }
      }

      progress.setRatio(1);

      const character = getCharacterName();
      sendBg({ type: 'restore_done', character });

      if (outcome === 'completed') {
        const saveBtns = findSaveButtons();
        if (saveBtns[0]) saveBtns[0].scrollIntoView({ behavior: 'smooth', block: 'center' });
        toast({
          title: 'Ready to save',
          message:
            `Form filled: ${result.fields} fields, ${result.kinks} kinks, ${result.customKinks} custom kinks. ` +
            (skipImages
              ? ''
              : `Images: ${counts.uploaded} uploaded, ${counts.deleted} deleted. `) +
            `Review every field above, then click F-list's Save button — the extension will NOT click it for you.`,
          kind: 'success',
          durationMs: 0,
        });
      } else {
        toast({
          title: 'Restore cancelled',
          message:
            `Stopped after ${counts.deleted}/${counts.deletePlanned} deletes and ` +
            `${counts.uploaded}/${counts.uploadPlanned} uploads. Form fields were filled. ` +
            `Image gallery is now in a partial state — re-run the import or fix manually on F-list.`,
          kind: 'warn',
          durationMs: 0,
        });
      }
    } finally {
      progress.restore();
      unlockSave();
    }
  }

  const KIND_LABEL = {
    live: 'From F-list',
    set: 'Working set',
    backup: 'Backup',
    'pre-restore': 'Pre-restore',
  };

  async function showSnapshotPicker(targetCharacter) {
    const modal = openModal({
      title: 'Restore from Workbench',
      body: makeEl('div', { text: 'Loading characters…' }),
      footer: [],
    });

    // The character we're editing (URL) is the target. The user can
    // pick a different "source" character whose snapshot they want to
    // load into the current edit form — useful for porting a profile
    // between throwaway characters or seeding a new char from an old.
    let sourceCharacter = targetCharacter;
    let selected = null;

    const cancelBtn = makeEl('button', { class: 'flist-wb-btn secondary', type: 'button', text: 'Cancel' });
    cancelBtn.addEventListener('click', () => modal.close());
    const loadBtn = makeEl('button', { class: 'flist-wb-btn', type: 'button', text: 'Load snapshot' });
    loadBtn.disabled = true;
    modal.footer.appendChild(cancelBtn);
    modal.footer.appendChild(loadBtn);

    const charsRes = await archivedCharactersList();
    modal.body.innerHTML = '';

    if (!charsRes.ok) {
      modal.body.appendChild(makeEl('div', { class: 'flist-wb-warn-box', text: explainError(charsRes) }));
      if (charsRes.error === 'not_paired') {
        modal.body.appendChild(makeEl('div', {
          text: 'Click the extension icon in the browser toolbar and press Pair to begin.',
        }));
      }
      return;
    }

    const archived = charsRes.characters || [];
    const sourceRow = makeEl('div', { class: 'flist-wb-source-row' });
    sourceRow.appendChild(makeEl('label', { text: 'Load from character:', for: 'flist-wb-source-select' }));
    const select = makeEl('select', { id: 'flist-wb-source-select' });

    if (archived.length === 0) {
      modal.body.appendChild(makeEl('div', {
        class: 'flist-wb-info-box',
        text: 'Workbench has no archived characters yet. Open a character in Workbench and pull it first.',
      }));
      return;
    }

    const hasTarget = archived.some((c) => c.name === targetCharacter);
    if (!hasTarget && targetCharacter) {
      const placeholder = makeEl('option', { value: '', text: `${targetCharacter} — no archive yet` });
      placeholder.disabled = true;
      select.appendChild(placeholder);
    }
    archived.forEach((c) => {
      const opt = makeEl('option', { value: c.name, text: c.name });
      if (c.name === targetCharacter) opt.selected = true;
      select.appendChild(opt);
    });

    if (!hasTarget && archived.length > 0) {
      sourceCharacter = archived[0].name;
      select.value = sourceCharacter;
    }

    sourceRow.appendChild(select);
    modal.body.appendChild(sourceRow);

    const warningSlot = makeEl('div');
    modal.body.appendChild(warningSlot);

    const listSlot = makeEl('div');
    modal.body.appendChild(listSlot);

    const renderWarning = () => {
      warningSlot.innerHTML = '';
      if (sourceCharacter && targetCharacter && sourceCharacter !== targetCharacter) {
        warningSlot.appendChild(makeEl('div', {
          class: 'flist-wb-source-warning',
          html: `⚠ You're loading data from <strong>${escapeHtml(sourceCharacter)}</strong> into the edit form for <strong>${escapeHtml(targetCharacter)}</strong>. Form fields will be overwritten — review every field before clicking Save.`,
        }));
      }
    };

    const renderSnapshots = async () => {
      selected = null;
      loadBtn.disabled = true;
      listSlot.innerHTML = '';
      listSlot.appendChild(makeEl('div', { text: 'Loading snapshots…', style: 'color:#8a93a8;padding:8px 0;' }));

      const res = await snapshotsList(sourceCharacter);
      listSlot.innerHTML = '';
      if (!res.ok) {
        listSlot.appendChild(makeEl('div', { class: 'flist-wb-warn-box', text: explainError(res) }));
        return;
      }
      const snapshots = res.snapshots || [];
      if (snapshots.length === 0) {
        listSlot.appendChild(makeEl('div', {
          class: 'flist-wb-info-box',
          text: `Workbench has no snapshots for "${sourceCharacter}". Pull or back up first, or pick another character.`,
        }));
        return;
      }
      snapshots.forEach((s) => {
        const row = makeEl('div', { class: 'flist-wb-snapshot-row' });
        const kindClass = String(s.kind || '').replace(/[^a-z-]/gi, '');
        row.appendChild(makeEl('span', {
          class: `flist-wb-snapshot-kind ${kindClass}`,
          text: KIND_LABEL[s.kind] || s.kind || '?',
        }));
        row.appendChild(makeEl('span', { text: s.label || s.id }));
        row.appendChild(makeEl('span', {
          class: 'flist-wb-snapshot-meta',
          text: `${s.image_count || 0} images · ${fmtRelative(s.created_at)}`,
        }));
        row.addEventListener('click', () => {
          listSlot.querySelectorAll('.flist-wb-snapshot-row').forEach((r) => r.classList.remove('selected'));
          row.classList.add('selected');
          selected = s;
          loadBtn.disabled = false;
        });
        listSlot.appendChild(row);
      });
    };

    select.addEventListener('change', () => {
      sourceCharacter = select.value || archived[0]?.name;
      renderWarning();
      renderSnapshots();
    });

    renderWarning();
    await renderSnapshots();

    loadBtn.addEventListener('click', async () => {
      if (!selected) return;
      loadBtn.disabled = true;
      loadBtn.textContent = 'Loading…';
      const fetched = await snapshotZipBytes(sourceCharacter, selected.id);
      if (!fetched.ok) {
        loadBtn.disabled = false;
        loadBtn.textContent = 'Load snapshot';
        toast({ title: 'Could not load snapshot', message: explainError(fetched), kind: 'error' });
        return;
      }
      modal.close();
      try {
        const zip = await window.JSZip.loadAsync(fetched.bytes);
        const jsonFile = zip.file('character.json');
        if (!jsonFile) throw new Error('character.json missing from snapshot ZIP');
        const data = JSON.parse(await jsonFile.async('string'));
        const sourceLabel = sourceCharacter === targetCharacter
          ? `Workbench · ${selected.label || selected.id}`
          : `Workbench · ${sourceCharacter} → ${targetCharacter} · ${selected.label || selected.id}`;
        await showSafetyScreen({
          data,
          source: sourceLabel,
          character: targetCharacter,
          lastBackupIso: selected.created_at,
          applyFn: ({ skipImages }) => doApply(zip, data, { skipImages }),
        });
      } catch (e) {
        toast({ title: 'Snapshot unreadable', message: String(e.message || e), kind: 'error' });
      }
    });
  }

  function importFromLocalZip() {
    const input = makeEl('input', { type: 'file', accept: '.zip,.json' });
    input.style.display = 'none';
    input.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const character = getCharacterName();
      const isZip = file.name.toLowerCase().endsWith('.zip');
      try {
        if (isZip) {
          const zip = await window.JSZip.loadAsync(file);
          const jsonFile = zip.file('character.json');
          if (!jsonFile) throw new Error('character.json missing from ZIP');
          const data = JSON.parse(await jsonFile.async('string'));
          await showSafetyScreen({
            data,
            source: `Local ZIP · ${file.name}`,
            character,
            lastBackupIso: data?.meta?.exportedAt || data?.meta?.extractedAt || null,
            applyFn: ({ skipImages }) => doApply(zip, data, { skipImages }),
          });
        } else {
          const text = await file.text();
          const data = JSON.parse(text);
          await showSafetyScreen({
            data,
            source: `Local JSON · ${file.name}`,
            character,
            lastBackupIso: data?.meta?.exportedAt || data?.meta?.extractedAt || null,
            applyFn: ({ skipImages }) => doApply(null, data, { skipImages: true }),
          });
        }
      } catch (e) {
        toast({ title: 'Could not load file', message: String(e.message || e), kind: 'error' });
      } finally {
        input.remove();
      }
    });
    document.body.appendChild(input);
    input.click();
  }

  async function refreshStatus(statusEl) {
    const res = await sendBg({ type: 'get_token_status' });
    if (res.paired) {
      statusEl.className = 'flist-wb-status paired';
      statusEl.textContent = '● Paired with Workbench';
    } else {
      statusEl.className = 'flist-wb-status unpaired';
      statusEl.textContent = '○ Not paired — open the extension popup to pair';
    }
  }

  function injectBar() {
    if (document.getElementById('flist-wb-bar')) return;
    const form = document.getElementById('CharacterForm');
    if (!form) return;

    const bar = makeEl('div', { class: 'flist-wb-bar', id: 'flist-wb-bar' });
    bar.appendChild(makeEl('span', { class: 'flist-wb-bar-label', text: 'F-list Workbench' }));

    const importBtn = makeEl('button', { class: 'flist-wb-btn', type: 'button', text: 'Import from Workbench' });
    importBtn.addEventListener('click', () => {
      const character = getCharacterName();
      if (!character) {
        toast({ title: 'No character', message: 'Could not determine character name from URL.', kind: 'error' });
        return;
      }
      showSnapshotPicker(character);
    });
    bar.appendChild(importBtn);

    const zipBtn = makeEl('button', { class: 'flist-wb-btn secondary', type: 'button', text: 'Import from ZIP file' });
    zipBtn.addEventListener('click', importFromLocalZip);
    bar.appendChild(zipBtn);

    const statusEl = makeEl('span', { class: 'flist-wb-status', text: '…' });
    bar.appendChild(statusEl);

    form.parentNode.insertBefore(bar, form);
    refreshStatus(statusEl);

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && 'workbench_token' in changes) refreshStatus(statusEl);
    });
  }

  injectBar();
})();
