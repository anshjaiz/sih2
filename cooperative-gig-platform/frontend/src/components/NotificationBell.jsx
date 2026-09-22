import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { HiOutlineBell, HiOutlineX } from 'react-icons/hi';
import { useAuth } from '../context/AuthContext';
import { useNotifications } from '../context/NotificationContext';

const MAX_PREVIEW = 5;
const MAX_TITLE = 60

const trimTitle = (t) =>
  t && t.length > MAX_TITLE ? t.slice(0, MAX_TITLE - 1) + '…' : t;

export default function NotificationBell() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { notifications, unreadCount, loading, markRead, markAllRead, removeOne } =
    useNotifications();

  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const roleBase = user?.role === 'admin' ? '/admin' : user?.role === 'worker' ? '/worker' : '/customer';
  const inboxPath = `${roleBase}/notifications`;
  const previews = (notifications || []).slice(0, MAX_PREVIEW);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        type="button"
        aria-label={t('notif.bell')}
        onClick={() => setOpen((v) => !v)}
        className="relative flex items-center rounded-lg p-2 text-gray-500 hover:bg-[#f6f7f2] hover:text-gray-700"
      >
        <HiOutlineBell className="h-5 w-5" />
        {unreadCount > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-4 min-w-[16px] items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 z-50 mt-2 w-80 overflow-hidden rounded-xl border border-[#e3e5dc] bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-[#e3e5dc] px-4 py-2.5">
            <h3 className="text-sm font-semibold text-[#17211b]">{t('notif.title')}</h3>
            {unreadCount > 0 && (
              <button
                type="button"
                onClick={() => markAllRead()}
                className="text-xs text-[#1d5a2f] hover:underline"
              >
                {t('notif.markAllRead')}
              </button>
            )}
          </div>

          {loading ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">{t('notif.loading')}</div>
          ) : previews.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-gray-400">{t('notif.empty')}</div>
          ) : (
            <ul className="max-h-80 divide-y divide-[#e3e5dc] overflow-y-auto">
              {previews.map((n) => {
                const unread = !n.isRead;
                return (
                  <li key={n._id || n.id}>
                    <div className="flex items-start gap-3 px-4 py-3 hover:bg-[#fbfcf8]">
                      <span
                        className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? 'bg-[#1d5a2f]' : 'bg-gray-300'}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className={`truncate text-sm ${unread ? 'font-medium text-[#17211b]' : 'text-gray-500'}`}>
                          {trimTitle(n.title)}
                        </p>
                        {n.message && (
                          <p className="mt-0.5 truncate text-xs text-gray-400">{n.message}</p>
                        )}
                      </div>
                      {unread && (
                        <button
                          type="button"
                          onClick={() => markRead(n._id || n.id)}
                          className="shrink-0 text-xs text-[#1d5a2f] hover:underline"
                        >
                          {t('notif.read')}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t('notif.delete')}
                        onClick={() => removeOne(n._id || n.id)}
                        className="shrink-0 text-gray-300 hover:text-red-500"
                      >
                        <HiOutlineX className="h-4 w-4" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <div className="border-t border-[#e3e5dc] p-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                navigate(inboxPath);
              }}
              className="w-full rounded-lg bg-[#1d5a2f] py-2 text-sm font-medium text-white hover:bg-[#174a26]"
            >
              {t('notif.viewAll')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
