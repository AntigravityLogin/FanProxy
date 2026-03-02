document.addEventListener('DOMContentLoaded', () => {
  const proxyInput = document.getElementById('proxyString');
  const connectBtn = document.getElementById('connectBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');
  const statusText = document.getElementById('statusText');
  const statusDot = document.getElementById('statusDot');
  const errorDiv = document.getElementById('error');
  const infoPanel = document.getElementById('info-panel');
  const proxySelect = document.getElementById('proxySelect');
  const proxyListWrap = document.getElementById('proxyListWrap');
  const saveProxyBtn = document.getElementById('saveProxyBtn');
  const deleteProxyBtn = document.getElementById('deleteProxyBtn');

  // ── Загрузка списка прокси ────────────────────────────────────────────────
  // Список хранится в chrome.storage.local под ключом 'savedProxies'.
  // При первом запуске подгружаем proxy.txt и сохраняем в storage.
  function loadProxyList(callback) {
    chrome.storage.local.get(['savedProxies', 'proxyListLoaded'], (result) => {
      if (result.proxyListLoaded) {
        // Список уже загружен ранее — используем из storage
        renderProxySelect(result.savedProxies || []);
        if (callback) callback();
      } else {
        // Первый запуск — грузим proxy.txt из папки расширения
        fetch(chrome.runtime.getURL('proxy.txt'))
          .then(r => r.text())
          .then(text => {
            const lines = text.split('\n')
              .map(l => l.trim())
              .filter(l => l.length > 0);
            chrome.storage.local.set({ savedProxies: lines, proxyListLoaded: true }, () => {
              renderProxySelect(lines);
              if (callback) callback();
            });
          })
          .catch(() => {
            // proxy.txt пустой или ошибка — пропускаем
            chrome.storage.local.set({ savedProxies: [], proxyListLoaded: true }, () => {
              renderProxySelect([]);
              if (callback) callback();
            });
          });
      }
    });
  }

  function renderProxySelect(list) {
    // Очищаем, оставляем первый placeholder option
    proxySelect.innerHTML = '<option value="">— выберите прокси —</option>';
    if (list && list.length > 0) {
      list.forEach(proxy => {
        const opt = document.createElement('option');
        opt.value = proxy;
        opt.textContent = proxy;
        proxySelect.appendChild(opt);
      });
      proxyListWrap.style.display = 'block';
    } else {
      proxyListWrap.style.display = 'none';
    }
  }

  // При выборе прокси из списка — подставляем в поле ввода
  proxySelect.addEventListener('change', () => {
    if (proxySelect.value) {
      proxyInput.value = proxySelect.value;
      errorDiv.style.display = 'none';
    }
  });

  // ── Сохранение прокси в список ───────────────────────────────────────────
  saveProxyBtn.addEventListener('click', () => {
    const proxyStr = proxyInput.value.trim();
    if (!proxyStr) {
      showError('Введите строку прокси для сохранения');
      return;
    }
    errorDiv.style.display = 'none';
    chrome.storage.local.get(['savedProxies'], (result) => {
      let list = result.savedProxies || [];
      // Удаляем дубликат если уже есть
      list = list.filter(p => p !== proxyStr);
      // Добавляем в начало
      list.unshift(proxyStr);
      chrome.storage.local.set({ savedProxies: list, proxyListLoaded: true }, () => {
        renderProxySelect(list);
        // Показываем индикацию сохранения
        const orig = saveProxyBtn.textContent;
        saveProxyBtn.textContent = '✓ Сохранено';
        saveProxyBtn.style.opacity = '0.7';
        setTimeout(() => {
          saveProxyBtn.textContent = orig;
          saveProxyBtn.style.opacity = '';
        }, 1500);
      });
    });
  });

  // ── Удаление прокси из списка ─────────────────────────────────────────────
  deleteProxyBtn.addEventListener('click', () => {
    const proxyStr = proxySelect.value;
    if (!proxyStr) return; // ничего не выбрано
    chrome.storage.local.get(['savedProxies'], (result) => {
      const list = (result.savedProxies || []).filter(p => p !== proxyStr);
      chrome.storage.local.set({ savedProxies: list }, () => {
        renderProxySelect(list);
        proxySelect.value = '';
        // Если удалённый прокси был в поле ввода — очищаем
        if (proxyInput.value.trim() === proxyStr) proxyInput.value = '';
      });
    });
  });

  // ── Загружаем сохранённые данные ─────────────────────────────────────────
  loadProxyList(() => {
    chrome.storage.local.get(['proxyString', 'proxyActive'], (result) => {
      if (result.proxyString) proxyInput.value = result.proxyString;
      updateStatus(result.proxyActive);
      showInfoPanel(); // показываем всегда — и с прокси, и без
    });
  });

  connectBtn.addEventListener('click', () => {
    const proxyStr = proxyInput.value.trim();
    errorDiv.style.display = 'none';

    if (!proxyStr) { showError('Введите строку прокси'); return; }

    try {
      const parsed = parseProxyString(proxyStr);
      if (!parsed) throw new Error('Некорректный формат');

      const { scheme, host, port, username, password } = parsed;

      const config = {
        mode: "fixed_servers",
        rules: {
          singleProxy: { scheme, host, port },
          bypassList: ["localhost", "127.0.0.1"]
        }
      };

      connectBtn.disabled = true;

      chrome.proxy.settings.set({ value: config, scope: 'regular' }, () => {
        const proxyAuth = (username && password) ? { username, password } : null;
        chrome.storage.local.set({ proxyActive: true, proxyString: proxyStr, proxyAuth }, () => {
          updateStatus(true);
          connectBtn.disabled = false;
          showInfoPanel();
        });
      });

    } catch (e) {
      showError('Неверный формат. Примеры:\nhttp://user:pass@ip:port\nhttp://ip:port:user:pass\nip:port:user:pass\nip:port');
    }
  });

  disconnectBtn.addEventListener('click', () => {
    chrome.proxy.settings.clear({ scope: 'regular' }, () => {
      chrome.storage.local.set({ proxyActive: false }, () => {
        updateStatus(false);
        showInfoPanel(); // обновляем данные — теперь без прокси
      });
    });
  });

  // ── Парсинг прокси ────────────────────────────────────────────────────────
  // Поддерживаемые форматы:
  //   1. http://user:pass@ip:port      (стандартный URL)
  //   2. socks5://user:pass@ip:port    (SOCKS через URL)
  //   3. http://ip:port:user:pass      (схема://ip:port:user:pass)
  //   4. ip:port:user:pass             (без схемы, с авторизацией)
  //   5. ip:port                        (без схемы и авторизации)
  function parseProxyString(raw) {
    raw = raw.trim();

    // Определяем схему и тело
    let scheme = 'http';
    let body = raw;

    const schemeMatch = raw.match(/^(https?|socks5?):\/\//i);
    if (schemeMatch) {
      scheme = schemeMatch[1].toLowerCase();
      body = raw.slice(schemeMatch[0].length);
    }

    // Проверяем стандартный URL-формат: user:pass@host:port
    if (body.includes('@')) {
      try {
        const url = new URL(schemeMatch ? raw : 'http://' + body);
        const host = url.hostname;
        const port = parseInt(url.port) || (scheme === 'https' ? 443 : 80);
        const username = decodeURIComponent(url.username);
        const password = decodeURIComponent(url.password);
        if (!host) return null;
        return { scheme, host, port, username, password };
      } catch { return null; }
    }

    // Нестандартный формат: разбиваем по ':'
    // body может быть: ip:port, ip:port:user:pass
    const parts = body.split(':');

    // ip:port
    if (parts.length === 2) {
      const host = parts[0];
      const port = parseInt(parts[1]);
      if (!host || isNaN(port)) return null;
      return { scheme, host, port, username: '', password: '' };
    }

    // ip:port:user:pass
    if (parts.length === 4) {
      const host = parts[0];
      const port = parseInt(parts[1]);
      const username = parts[2];
      const password = parts[3];
      if (!host || isNaN(port)) return null;
      return { scheme, host, port, username, password };
    }

    return null;
  }

  function updateStatus(isActive) {
    statusText.textContent = isActive ? 'Подключён' : 'Отключён';
    statusDot.className = 'dot ' + (isActive ? 'active' : 'inactive');
  }

  function showError(msg) {
    errorDiv.textContent = msg;
    errorDiv.style.display = 'block';
  }

  // ── IP Info Panel ──────────────────────────────────
  function showInfoPanel() {
    infoPanel.style.display = 'block';
    resetGeo();
    fetchIP();
    pingSites();
  }

  function resetGeo() {
    ['ip-val', 'g-country', 'g-city', 'g-region', 'g-tz'].forEach(id => {
      const el = document.getElementById(id);
      el.textContent = '···';
      el.className = el.className.replace('empty', '') + (id === 'ip-val' ? ' loading' : ' empty');
    });
    ['p0', 'p1', 'p2', 'p3'].forEach(id => {
      document.getElementById(id).className = 'ping-chip';
    });
  }

  function fetchIP() {
    const xhr = new XMLHttpRequest();
    xhr.timeout = 10000;
    xhr.open('GET', 'http://www.ixbrowser.com/api/ip-api');
    xhr.onload = () => {
      const ipEl = document.getElementById('ip-val');
      ipEl.classList.remove('loading');
      if (xhr.status === 200) {
        try {
          const d = JSON.parse(xhr.response);
          ipEl.textContent = d.query || '—';

          const set = (id, val) => {
            const el = document.getElementById(id);
            el.textContent = val || '—';
            el.className = 'g-val' + (val ? '' : ' empty');
          };
          set('g-country', d.country);
          set('g-city', d.city);
          set('g-region', d.regionName);
          set('g-tz', d.timezone);
        } catch (e) { ipEl.textContent = 'Ошибка'; }
      } else {
        ipEl.textContent = 'Ошибка';
      }
    };
    xhr.onerror = () => {
      const ipEl = document.getElementById('ip-val');
      ipEl.classList.remove('loading');
      ipEl.textContent = 'Ошибка';
    };
    xhr.send();
  }

  function pingSites() {
    const sites = [
      { id: 'p0', url: 'https://www.google.com/' },
      { id: 'p1', url: 'https://www.amazon.com/' },
      { id: 'p2', url: 'https://yandex.com/' },
      { id: 'p3', url: 'https://www.tiktok.com/' },
    ];
    sites.forEach(({ id, url }) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5000);
      fetch(url, { mode: 'no-cors', signal: controller.signal })
        .then(() => {
          clearTimeout(timer);
          document.getElementById(id).className = 'ping-chip ok';
        })
        .catch(() => {
          clearTimeout(timer);
          document.getElementById(id).className = 'ping-chip fail';
        });
    });
  }
});
