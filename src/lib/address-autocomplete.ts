import { authFetch } from './api';

export type AddressSuggestion = {
  id: string;
  label: string;
  rue: string | null;
  ville: string | null;
  code_postal: string | null;
  pays: string | null;
  latitude: number;
  longitude: number;
  provider: 'geoapify' | 'nominatim';
};

type InitOptions = {
  input: HTMLInputElement;
  currentLocationLabel?: string;
  onSelect?: (suggestion: AddressSuggestion) => void;
};

const cache = new Map<string, AddressSuggestion[]>();
let stylesInjected = false;

function injectStyles() {
  if (stylesInjected || typeof document === 'undefined') return;
  stylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .fp-address-field{position:relative}
    .fp-address-input{padding-left:2.9rem!important;padding-right:3rem!important}
    .fp-address-icon{position:absolute;left:1rem;top:50%;transform:translateY(-50%);width:1.05rem;height:1.05rem;color:#2563eb;pointer-events:none;z-index:2}
    .fp-address-spinner{position:absolute;right:1rem;top:50%;width:1rem;height:1rem;margin-top:-.5rem;border:2px solid rgba(37,99,235,.16);border-top-color:#2563eb;border-radius:999px;animation:fp-address-spin .7s linear infinite;display:none;z-index:2}
    .fp-address-field[data-loading='true'] .fp-address-spinner{display:block}
    .fp-address-menu{position:absolute;z-index:60;left:0;right:0;top:calc(100% + .45rem);overflow:hidden;border:1px solid rgba(191,219,254,.9);border-radius:1.1rem;background:rgba(255,255,255,.96);box-shadow:0 24px 60px -28px rgba(15,23,42,.36);backdrop-filter:blur(14px);display:none}
    .fp-address-menu[data-open='true']{display:block}
    .fp-address-option{width:100%;display:flex;gap:.75rem;align-items:flex-start;padding:.85rem 1rem;border:0;background:transparent;text-align:left;cursor:pointer;transition:background .18s ease}
    .fp-address-option:hover,.fp-address-option[data-active='true']{background:linear-gradient(135deg,rgba(239,246,255,.96),rgba(224,242,254,.78))}
    .fp-address-option strong{display:block;color:#0f172a;font-size:.9rem;line-height:1.25}
    .fp-address-option span{display:block;color:#64748b;font-size:.75rem;line-height:1.35;margin-top:.2rem}
    .fp-address-pin{margin-top:.1rem;display:inline-flex;align-items:center;justify-content:center;width:1.85rem;height:1.85rem;flex:0 0 auto;border-radius:.75rem;background:#eff6ff;color:#2563eb}
    .fp-address-current{width:100%;display:flex;align-items:center;gap:.65rem;padding:.85rem 1rem;border:0;border-top:1px solid rgba(226,232,240,.9);background:#f8fafc;color:#1d4ed8;font-size:.83rem;font-weight:800;cursor:pointer;transition:background .18s ease}
    .fp-address-current:hover{background:#eff6ff}
    .fp-address-empty{padding:.85rem 1rem;color:#64748b;font-size:.83rem}
    @keyframes fp-address-spin{to{transform:rotate(360deg)}}
    @media (max-width:640px){.fp-address-menu{position:fixed;left:1rem;right:1rem;top:auto;bottom:1rem;max-height:45vh;overflow:auto;border-radius:1.25rem}.fp-address-option{padding:1rem}.fp-address-option strong{font-size:.95rem}}
  `;
  document.head.appendChild(style);
}

function iconSvg(path: string) {
  return `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

function escapeHtml(value: unknown) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
  }[char] ?? char));
}

function setAddressDataset(input: HTMLInputElement, suggestion: AddressSuggestion) {
  input.dataset.latitude = String(suggestion.latitude);
  input.dataset.longitude = String(suggestion.longitude);
  input.dataset.rue = suggestion.rue ?? '';
  input.dataset.ville = suggestion.ville ?? '';
  input.dataset.codePostal = suggestion.code_postal ?? '';
  input.dataset.pays = suggestion.pays ?? '';
}

export function clearAddressPayload(input: HTMLInputElement) {
  delete input.dataset.latitude;
  delete input.dataset.longitude;
  delete input.dataset.rue;
  delete input.dataset.ville;
  delete input.dataset.codePostal;
  delete input.dataset.pays;
}

export function getAddressPayload(input: HTMLInputElement) {
  const latitude = Number(input.dataset.latitude);
  const longitude = Number(input.dataset.longitude);
  const hasCoordinates = Number.isFinite(latitude) && Number.isFinite(longitude);
  return {
    rue: input.dataset.rue || null,
    ville: input.dataset.ville || null,
    code_postal: input.dataset.codePostal || null,
    pays: input.dataset.pays || null,
    latitude: hasCoordinates ? latitude : null,
    longitude: hasCoordinates ? longitude : null,
  };
}

async function fetchSuggestions(query: string) {
  const key = query.trim().toLowerCase();
  if (cache.has(key)) return cache.get(key) ?? [];
  const response = await authFetch(`/api/geocoding/autocomplete?q=${encodeURIComponent(query)}&limit=6`);
  const payload = await response.json().catch(() => null);
  const suggestions = response.ok && Array.isArray(payload?.data) ? payload.data as AddressSuggestion[] : [];
  cache.set(key, suggestions);
  return suggestions;
}

async function reverseCurrentPosition(latitude: number, longitude: number) {
  const response = await authFetch(`/api/geocoding/reverse?lat=${encodeURIComponent(latitude)}&lng=${encodeURIComponent(longitude)}`);
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.data) throw new Error(payload?.error ?? 'Adresse introuvable.');
  return payload.data as AddressSuggestion;
}

function ensureWrapper(input: HTMLInputElement) {
  const parent = input.parentElement;
  if (parent?.classList.contains('fp-address-field')) return parent;

  const wrapper = document.createElement('div');
  wrapper.className = 'fp-address-field';
  input.classList.add('fp-address-input');
  parent?.insertBefore(wrapper, input);
  wrapper.appendChild(input);
  return wrapper;
}

export function initAddressAutocomplete({ input, currentLocationLabel = 'Utiliser ma position actuelle', onSelect }: InitOptions) {
  if (!input || input.dataset.addressAutocompleteReady === 'true') return;
  input.dataset.addressAutocompleteReady = 'true';
  injectStyles();

  const wrapper = ensureWrapper(input);
  const icon = document.createElement('span');
  icon.className = 'fp-address-icon';
  icon.innerHTML = iconSvg('M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z');
  const spinner = document.createElement('span');
  spinner.className = 'fp-address-spinner';
  const menu = document.createElement('div');
  menu.className = 'fp-address-menu';
  menu.setAttribute('role', 'listbox');
  wrapper.append(icon, spinner, menu);

  let timeout: number | null = null;
  let suggestions: AddressSuggestion[] = [];
  let activeIndex = -1;

  function close() {
    menu.dataset.open = 'false';
    activeIndex = -1;
  }

  function render(extraMessage = '') {
    const suggestionHtml = suggestions.map((suggestion, index) => {
      const detail = [suggestion.rue, suggestion.code_postal, suggestion.ville, suggestion.pays].filter(Boolean).join(' · ');
      return `
        <button type="button" class="fp-address-option" role="option" data-index="${index}" data-active="${index === activeIndex ? 'true' : 'false'}">
          <span class="fp-address-pin">${iconSvg('M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0Z M12 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z')}</span>
          <span><strong>${escapeHtml(suggestion.label)}</strong><span>${escapeHtml(detail || 'Adresse détectée')}</span></span>
        </button>
      `;
    }).join('');

    menu.innerHTML = `
      ${suggestionHtml || (extraMessage ? `<div class="fp-address-empty">${extraMessage}</div>` : '')}
      <button type="button" class="fp-address-current">${iconSvg('M12 3v3 M12 18v3 M3 12h3 M18 12h3 M7.8 7.8l-2.1-2.1 M18.3 18.3l-2.1-2.1 M16.2 7.8l2.1-2.1 M5.7 18.3l2.1-2.1 M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z')} ${currentLocationLabel}</button>
    `;

    menu.querySelectorAll<HTMLButtonElement>('.fp-address-option').forEach((button) => {
      button.addEventListener('click', () => selectSuggestion(Number(button.dataset.index)));
    });
    menu.querySelector<HTMLButtonElement>('.fp-address-current')?.addEventListener('click', useCurrentPosition);
    menu.dataset.open = 'true';
  }

  function selectSuggestion(index: number) {
    const suggestion = suggestions[index];
    if (!suggestion) return;
    input.value = suggestion.label;
    setAddressDataset(input, suggestion);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new CustomEvent('address:selected', { bubbles: true, detail: suggestion }));
    onSelect?.(suggestion);
    close();
  }

  async function search() {
    const query = input.value.trim();
    clearAddressPayload(input);
    if (query.length < 3) {
      suggestions = [];
      close();
      return;
    }

    wrapper.dataset.loading = 'true';
    try {
      suggestions = await fetchSuggestions(query);
      activeIndex = suggestions.length ? 0 : -1;
      render(suggestions.length ? '' : 'Aucune adresse trouvée.');
    } catch {
      suggestions = [];
      render('Impossible de charger les suggestions.');
    } finally {
      wrapper.dataset.loading = 'false';
    }
  }

  function scheduleSearch() {
    if (timeout) window.clearTimeout(timeout);
    timeout = window.setTimeout(search, 300);
  }

  function useCurrentPosition() {
    if (!navigator.geolocation) {
      render('La géolocalisation navigateur est indisponible.');
      return;
    }
    wrapper.dataset.loading = 'true';
    navigator.geolocation.getCurrentPosition(
      async (position) => {
        try {
          const suggestion = await reverseCurrentPosition(position.coords.latitude, position.coords.longitude);
          suggestions = [suggestion];
          selectSuggestion(0);
        } catch {
          render('Impossible de retrouver votre adresse actuelle.');
        } finally {
          wrapper.dataset.loading = 'false';
        }
      },
      () => {
        wrapper.dataset.loading = 'false';
        render('Autorisez la localisation pour utiliser votre position.');
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  }

  input.addEventListener('input', scheduleSearch);
  input.addEventListener('focus', () => {
    if (suggestions.length > 0) render();
  });
  input.addEventListener('keydown', (event) => {
    if (menu.dataset.open !== 'true') return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      activeIndex = Math.min(activeIndex + 1, suggestions.length - 1);
      render();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
      render();
    } else if (event.key === 'Enter' && activeIndex >= 0) {
      event.preventDefault();
      selectSuggestion(activeIndex);
    } else if (event.key === 'Escape') {
      close();
    }
  });
  document.addEventListener('click', (event) => {
    if (!wrapper.contains(event.target as Node)) close();
  });
}
