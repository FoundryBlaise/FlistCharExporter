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

  function setFieldValue(el, value) {
    if (el.type === 'checkbox') {
      el.checked = !!value;
    } else {
      el.value = value;
    }
    fireChange(el);
  }

  function applyCharacterData(data) {
    const form = document.getElementById('CharacterForm');
    if (!form) throw new Error('Character form not found on page');

    const result = { fields: 0, kinks: 0, customKinks: 0, warnings: [] };

    const desc = form.querySelector('[name="description"]');
    if (desc) { setFieldValue(desc, data.character?.description || ''); result.fields++; }
    const title = form.querySelector('[name="custom_title"]');
    if (title) { setFieldValue(title, data.character?.customTitle || ''); result.fields++; }

    if (data.settings) {
      for (const [name, value] of Object.entries(data.settings)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (!el) continue;
        setFieldValue(el, value);
        result.fields++;
      }
    }

    if (data.infotags && Object.keys(data.infotags).length > 0) {
      for (const [name, value] of Object.entries(data.infotags)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (el) { setFieldValue(el, value); result.fields++; }
      }
    }

    if (data.kinks && Object.keys(data.kinks).length > 0) {
      for (const [name, value] of Object.entries(data.kinks)) {
        const el = form.querySelector(`[name="${name}"]`);
        if (el) { setFieldValue(el, value); result.kinks++; }
      }
    }

    // Custom kinks: F-list's API for add/remove lives on `window.FList`
    // in the page's main world — invisible from this isolated-world
    // content script. Inject a script that does the orchestration
    // in-page, including filling each row's fields.
    const customKinksJson = JSON.stringify(data.customKinks || []);
    const customScript = `
      (function(payload){
        try {
          var existing = document.querySelectorAll(
            '[id^="CustomKink"]:not([id="CustomKinksList"]):not([id*="TEMPLATE"])'
          );
          existing.forEach(function(container){
            var m = container.id.match(/CustomKink(\\d+)/);
            if (m && typeof window.$ !== 'undefined' && typeof window.FList !== 'undefined') {
              window.$('#' + container.id).remove();
              if (window.FList.Subfetish && window.FList.Subfetish.Data) {
                window.FList.Subfetish.Data.removeCustom(m[1]);
              }
            }
          });
          if (!payload.length) return;
          if (typeof window.FList === 'undefined' ||
              typeof window.FList.CharEditor_addKink !== 'function') return;
          for (var i = 0; i < payload.length; i++) window.FList.CharEditor_addKink();
          setTimeout(function(){
            var form = document.getElementById('CharacterForm');
            if (!form) return;
            var ns = form.querySelectorAll('[name="customkinkname[]"]');
            var ds = form.querySelectorAll('[name="customkinkdescription[]"]');
            var cs = form.querySelectorAll('[name="customkinkchoice[]"]');
            payload.forEach(function(kink, i){
              if (ns[i]) {
                ns[i].value = kink.name || '';
                ns[i].dispatchEvent(new Event('input', { bubbles: true }));
                ns[i].dispatchEvent(new Event('change', { bubbles: true }));
              }
              if (ds[i]) {
                ds[i].value = kink.description || '';
                ds[i].dispatchEvent(new Event('input', { bubbles: true }));
              }
              if (cs[i]) {
                cs[i].value = kink.choice || 'undecided';
                cs[i].dispatchEvent(new Event('change', { bubbles: true }));
              }
            });
          }, 120);
        } catch (e) { console.error('[F-list Workbench] custom-kink fill failed', e); }
      })(${customKinksJson});
    `;
    execInPageWorld(customScript);
    result.customKinks = (data.customKinks || []).length;

    return result;
  }

  // MV3 isolated world can't see page-defined globals like uploadImage,
  // deleteImage, FList.*. Injecting a <script> with the call runs in
  // the page's main world. The script is removed immediately after
  // execution; even if a security scanner walks the DOM later it
  // won't find injected code.
  function execInPageWorld(code) {
    const script = document.createElement('script');
    script.textContent = code;
    (document.head || document.documentElement).appendChild(script);
    script.remove();
  }

  function uploadSingleImage(bytes, filename) {
    return new Promise((resolve, reject) => {
      const fileInput = document.getElementById('imagefile');
      if (!fileInput) return reject(new Error('Image file input not found'));

      const beforeCount = document.querySelectorAll('.character_image').length;
      const mime = filename.endsWith('.png') ? 'image/png'
                 : filename.endsWith('.gif') ? 'image/gif' : 'image/jpeg';
      const file = new File([new Blob([bytes], { type: mime })], filename, { type: mime });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;

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
          reject(new Error('Upload timeout'));
        }
      }, 500);

      execInPageWorld('if(typeof uploadImage==="function")uploadImage();');
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
    return new Promise((resolve, reject) => {
      const idStr = JSON.stringify(String(imageId));
      execInPageWorld(`if(typeof deleteImage==="function")deleteImage(${idStr});`);
      let attempts = 0;
      const interval = setInterval(() => {
        attempts++;
        if (!document.getElementById(`image${imageId}`)) {
          clearInterval(interval);
          resolve();
        } else if (attempts >= 20) {
          clearInterval(interval);
          reject(new Error('Delete timeout'));
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

  async function doApply(zip, data, { skipImages }) {
    const statusToast = toast({ title: 'Applying restore', message: 'Filling form fields…', kind: 'info', durationMs: 0 });
    try {
      const result = applyCharacterData(data);

      if (!skipImages) {
        const current = extractImageData();
        const backupImages = data?.images?.list || [];
        const { willDelete } = diffImageSets(current.images, backupImages);

        for (let i = 0; i < willDelete.length; i++) {
          statusToast.querySelector('.flist-wb-toast-title').textContent = 'Applying restore';
          statusToast.lastChild.textContent = `Deleting image ${i + 1}/${willDelete.length}…`;
          try { await deleteImageById(willDelete[i].id); }
          catch (e) { warn('delete failed', willDelete[i].id, e); }
        }

        if (data?.images?.avatar?.filename) {
          const avatarFile = zip ? zip.file(data.images.avatar.filename) : null;
          if (avatarFile) {
            statusToast.lastChild.textContent = 'Uploading avatar…';
            try {
              const bytes = await avatarFile.async('uint8array');
              await uploadAvatarBytes(bytes, data.images.avatar.filename.split('/').pop());
            } catch (e) { warn('avatar upload failed', e); }
          }
        }

        // Upload only the images that aren't already on F-list — the
        // backup's full image list often contains entries whose id
        // also exists on the page, and re-uploading those would create
        // duplicates with new F-list-minted ids.
        const { willAdd: toUpload } = diffImageSets(extractImageData().images, backupImages);
        if (zip && toUpload.length > 0) {
          for (let i = toUpload.length - 1; i >= 0; i--) {
            const meta = toUpload[i];
            statusToast.lastChild.textContent = `Uploading image ${toUpload.length - i}/${toUpload.length}…`;
            const file = zip.file(meta.filename);
            if (!file) continue;
            try {
              const bytes = await file.async('uint8array');
              const filename = meta.filename.split('/').pop();
              const newId = await uploadSingleImage(bytes, filename);
              if (meta.description && newId) {
                const descInput = document.querySelector(`#image${newId} .character_image_description`);
                if (descInput) descInput.value = meta.description;
              }
            } catch (e) { warn('image upload failed', meta.filename, e); }
          }
        }
      }

      statusToast.remove();

      const character = getCharacterName();
      sendBg({ type: 'restore_done', character });

      const saveBtn = document.querySelector('input[type="submit"], button[type="submit"]');
      if (saveBtn) saveBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });

      toast({
        title: 'Ready to save',
        message: `Form filled: ${result.fields} fields, ${result.kinks} kinks, ${result.customKinks} custom kinks. ` +
                 `Review every field above, then click F-list's Save button — the extension will NOT click it for you.`,
        kind: 'success',
        durationMs: 0,
      });
    } catch (e) {
      statusToast.remove();
      throw e;
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
