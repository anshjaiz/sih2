import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { HiChevronLeft, HiChevronRight, HiOutlineInbox } from 'react-icons/hi';
import Spinner from '../components/Spinner';
import { useNotifications } from '../context/NotificationContext';

const PAGE_SIZE = 15;

export default function Notifications() {
  const { t } = useTranslation();
  const { notifications, unreadCount, loading, error, pagination, refresh, markRead, markAllRead, removeOne } =
    useNotifications();

  const [page, setPage] = useState(1);

  useEffect(() => {
    refresh({ page, limit: PAGE_SIZE });
    // re-run when the portal (role) changes so we always hit the right inbox
  }, [page]);

  const totalPages = pagination?.totalPages || 1;
  const total = pagination?.total ?? 0;

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-[#17211b]">{t('notif.title')}</h1>
          <p className="mt-1 text-sm text-gray-500">
            {t('notif.inbox', { count: total })}
          </p>
        </div>
        {unreadCount > 0 && (
          <button
            type="button"
            onClick={() => markAllRead()}
            className="rounded-lg border border-[#1d5a2f] px-4 py-2 text-sm font-medium text-[#1d5a2f] hover:bg-[#1d5a2f] hover:text-white"
          >
            {t('notif.markAllRead')}
          </button>
        )}
      </div>

      {loading ? (
        <div className="flex justify-center py-20">
          <Spinner />
        </div>
      ) : error ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-6 text-center text-sm text-red-600">
          {t('notif.error', { msg: error })}
        </div>
      ) : notifications.length === 0 ? (
        <div className="rounded-xl border border-[#e3e5dc] bg-white py-16 text-center">
          <HiOutlineInbox className="mx-auto h-10 w-10 text-gray-300" />
          <p className="mt-3 text-sm text-gray-500">{t('notif.empty')}</p>
        </div>
      ) : (
        <div className="overflow-hidden rounded-xl border border-[#e3e5dc] bg-white">
          <ul className="divide-y divide-[#e3e5dc]">
            {notifications.map((n) => {
              const unread = !n.isRead;
              return (
                <li key={n._id || n.id}>
                  <div
                    className={`flex w-full items-start gap-3 px-5 py-4 text-left ${
                      unread ? 'bg-[#f6f9f3]' : ''
                    }`}
                  >
                    <span
                      className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                        unread ? 'bg-[#1d5a2f]' : 'bg-gray-200'
                      }`}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline justify-between gap-3">
                        <h3
                          className={`truncate text-sm font-medium text-[#17211b] ${
                            unread ? '' : 'text-gray-600'
                          }`}
                        >
                          {n.title}
                        </h3>
                        {n.createdAt && (
                          <span className="shrink-0 text-xs text-gray-400">
                            {new Date(n.createdAt).toLocaleString()}
                          </span>
                        )}
                      </div>
                      {n.message && (
                        <p className="mt-1 text-sm text-gray-500">{n.message}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {unread && (
                        <button
                          type="button"
                          onClick={() => markRead(n._id || n.id)}
                          className="text-xs text-[#1d5a2f] hover:underline"
                        >
                          {t('notif.read')}
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={t('notif.delete')}
                        onClick={() => removeOne(n._id || n.id)}
                        className="text-xs text-gray-300 hover:text-red-500"
                      >
                        ×
                      </button>
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>

          {totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-[#e3e5dc] px-5 py-3">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
                className="flex items-center gap-1 text-sm text-[#1d5a2f] disabled:cursor-not-allowed disabled:text-gray-300"
              >
                <HiChevronLeft className="h-4 w-4" />
                {t('notif.prev')}
              </button>
              <span className="text-sm text-gray-500">
                {t('notif.page', { n: page, of: totalPages })}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
                className="flex items-center gap-1 text-sm text-[#1d5a2f] disabled:cursor-not-allowed disabled:text-gray-300"
              >
                {t('notif.next')}
                <HiChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
