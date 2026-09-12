import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';

const categoryIcons = {
  'Plumbing': '🔧', 'Electrical': '⚡', 'Carpentry': '🪵', 'Painting': '🎨',
  'Cleaning': '🧹', 'Gardening': '🌿', 'Driving': '🚗', 'Appliance Repair': '🔩',
  'Domestic Help': '🏠', 'Caregiving': '❤️', 'Other community services': '🌐',
};

export default function Services() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [services, setServices] = useState([]);
  const [categories, setCategories] = useState([]);
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [loading, setLoading] = useState(true);
  const searchBoxRef = useRef(null);

  useEffect(() => {
    const load = async () => {
      try {
        const [svcRes, catRes] = await Promise.all([
          api.get('/services'),
          api.get('/services/categories'),
        ]);
        setServices(svcRes.data || []);
        setCategories(['All', ...(catRes.data || [])]);
      } catch (e) {
        console.error(e);
      }
      setLoading(false);
    };
    load();
  }, []);

  const matches = services.filter((s) => {
    const matchCat = selectedCategory === 'All' || s.category === selectedCategory;
    const q = search.trim().toLowerCase();
    const matchSearch =
      !q ||
      s.name.toLowerCase().includes(q) ||
      s.category.toLowerCase().includes(q) ||
      (s.description || '').toLowerCase().includes(q);
    return matchCat && matchSearch;
  });

  const suggestions = matches.slice(0, 8);

  const filtered = services.filter((s) => {
    const matchCat = selectedCategory === 'All' || s.category === selectedCategory;
    const matchSearch = !search || s.name.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  });

  const selectService = (svc) => {
    setOpen(false);
    setSearch('');
    navigate(`/customer/services/request/${svc._id}`);
  };

  const handleKeyDown = (e) => {
    if (!open || suggestions.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % suggestions.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? suggestions.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (activeIndex >= 0 && suggestions[activeIndex]) selectService(suggestions[activeIndex]);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  useEffect(() => {
    const onDocClick = (e) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  const translateCat = (key) => {
    if (key === 'All') return t('cats.all');
    return t(`cats.${key}`, key);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <h2 className="text-xl font-bold text-gray-900">{t('svc.title')}</h2>
        <div className="relative max-w-xs w-full" ref={searchBoxRef}>
          <div className="relative">
            <input
              type="text"
              placeholder={t('svc.searchPlaceholder')}
              className="input-field w-full pr-9"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setOpen(true); setActiveIndex(-1); }}
              onFocus={() => setOpen(true)}
              onKeyDown={handleKeyDown}
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 pointer-events-none">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-4.35-4.35M17 10a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
            </span>
          </div>

          {open && suggestions.length > 0 && (
            <ul className="absolute z-20 mt-2 w-full bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
              {suggestions.map((svc, idx) => (
                <li key={svc._id}>
                  <button
                    type="button"
                    onMouseDown={(e) => { e.preventDefault(); selectService(svc); }}
                    onMouseEnter={() => setActiveIndex(idx)}
                    className={`w-full flex items-center justify-between gap-3 px-4 py-3 text-left transition-colors ${
                      activeIndex === idx ? 'bg-brand-50' : 'hover:bg-gray-50'
                    }`}
                  >
                    <span className="flex items-center gap-2 min-w-0">
                      <span className="text-lg shrink-0">{categoryIcons[svc.category] || '🔧'}</span>
                      <span className="truncate">
                        <span className="block text-sm font-semibold text-gray-900">{svc.name}</span>
                        <span className="block text-xs text-gray-500">{translateCat(svc.category)}</span>
                      </span>
                    </span>
                    <span className="text-sm font-bold text-brand-600 shrink-0">₹{svc.basePrice}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {categories.map((cat) => (
          <button
            key={cat}
            onClick={() => setSelectedCategory(cat)}
            className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
              selectedCategory === cat
                ? 'bg-brand-600 text-white'
                : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
            }`}
          >
            {cat !== 'All' && categoryIcons[cat] ? `${categoryIcons[cat]} ` : ''}{translateCat(cat)}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div>
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-gray-400">{t('svc.noServices')}</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-5">
          {filtered.map((svc) => (
            <div key={svc._id} className="card hover:shadow-md transition-shadow">
              <div className="flex items-center gap-3 mb-3">
                <span className="text-3xl">{categoryIcons[svc.category] || '🔧'}</span>
                <div>
                  <h3 className="font-semibold text-gray-900">{svc.name}</h3>
                  <span className="badge badge-info text-xs">{translateCat(svc.category)}</span>
                </div>
              </div>
              <p className="text-sm text-gray-500 mb-4 line-clamp-2">{svc.description}</p>
              <div className="flex items-center justify-between text-sm">
                <div>
                  <p className="text-gray-500">{t('svc.basePrice')}</p>
                  <p className="font-bold text-lg text-brand-600">₹{svc.basePrice}</p>
                </div>
                <div className="text-right text-gray-500">
                  <p>{svc.estimatedDuration} {t('common.min')}</p>
                  <p className="text-xs">{svc.unit || t('common.perVisit')}</p>
                </div>
              </div>
              {svc.emergencyAvailable && (
                <p className="text-xs text-orange-600 mt-2 font-medium">{t('svc.emergencyAvailable')}</p>
              )}
              <Link
                to={`/customer/services/request/${svc._id}`}
                className="btn-primary w-full mt-4 text-center text-sm"
              >
                {t('svc.bookNow')}
              </Link>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}