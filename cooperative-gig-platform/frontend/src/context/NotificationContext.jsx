import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useAuth } from './AuthContext';
import { getSocket } from '../services/socket';
import {
  getMyNotifications,
  getUnreadCount,
  markAllAsRead,
  markAsRead,
  deleteNotification,
} from '../services/notificationService';

const NotificationContext = createContext(null);

export const useNotifications = () => useContext(NotificationContext);

/**
 * Shared notification state for the whole portal (bell badge, dropdown and the
 * full list page). One provider is mounted at the portal root regardless of
 * role, so a single Socket.IO subscription powers all three layouts.
 *
 * Backend contract (see services/notificationService.js):
 *   GET  /notifications          -> { success, data, pagination, unreadCount }
 *   GET  /notifications/unread-count -> { success, data: { count } }
 *   PUT  /notifications/read-all
 *   PUT  /notifications/:id/read
 *   DELETE /notifications/:id
 */
export const NotificationProvider = ({ children }) => {
  const { user } = useAuth();

  const [notifications, setNotifications] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [pagination, setPagination] = useState(null);

  // Guard against out-of-order responses overwriting fresher ones.
  const fetchSeq = useRef(0);
  // Only bind the socket listener once per authenticated identity so that a
  // re-render never duplicates handlers.
  const boundUserKey = useRef((null));

  const loadNotifications = useCallback(
    async ({ page = 1, limit = 15 } = {}) => {
      if (!user) {
        setNotifications([]);
        setUnreadCount(0);
        setPagination(null);
        setLoading(false);
        return;
      }
      const seq = ++fetchSeq.current;
      setLoading(true);
      try {
        const res = await getMyNotifications({ page, limit });
        if (seq !== fetchSeq.current) return; // superseded by a newer call
        setNotifications(Array.isArray(res.data) ? res.data : []);
        setPagination(res.pagination || null);
        if (typeof res.unreadCount === 'number') setUnreadCount(res.unreadCount);
        else if (res.unreadCount === undefined && res.unreadCount !== 0) {
          try {
            const c = await getUnreadCount();
            setUnreadCount(c?.data?.count || 0);
          } catch {
            /* keep the last known badge value */
          }
        }
        setError(null);
      } catch (e) {
        if (seq === fetchSeq.current) setError(e?.message || 'Failed to load notifications');
      } finally {
        if (seq === fetchSeq.current) setLoading(false);
      }
    },
    [user]
  );

  const refresh = useCallback(async (opts) => {
    await loadNotifications(opts);
    if (user) {
      try {
        const c = await getUnreadCount();
        setUnreadCount(c?.data?.count || 0);
      } catch {
        /* non-fatal */
      }
    }
  }, [loadNotifications, user]);

  // Initial load when the authenticated identity changes.
  useEffect(() => {
    loadNotifications({ page: 1, limit: 15 });
  }, [loadNotifications]);

  // Real-time: the backend emits a `notification` event to the `user_<id>` room
  // the moment a new one is persisted. Prepend it and bump the unread badge.
  useEffect(() => {
    if (!user) return undefined;
    const socket = getSocket();
    if (!socket) return undefined;
    const key = 'notif_' + user._id;
    if (boundUserKey.current === key) return undefined;
    boundUserKey.current = key;

    const onNew = (n) => {
      if (!n || !n._id) return;
      setNotifications((prev) => [n, ...prev.filter((x) => (x._id || x.id) !== n._id)]);
      if (!n.isRead) setUnreadCount((c) => c + 1);
    };
    socket.on('notification', onNew);
    return () => {
      socket.off('notification', onNew);
      if (boundUserKey.current === key) boundUserKey.current = null;
    };
  }, [user]);

  const markRead = useCallback(async (id) => {
    setNotifications((prev) =>
      prev.map((n) => (n._id || n.id) === id ? { ...n, isRead: true } : n)
    );
    setUnreadCount((c) => Math.max(c - 1, 0));
    try {
      await markAsRead(id);
    } catch {
      /* reconcile on next fetch */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    setNotifications((prev) => prev.map((n) => ({ ...n, isRead: true })));
    setUnreadCount(0);
    try {
      await markAllAsRead();
    } catch {
      /* reconcile on next fetch */
    }
  }, []);

  const removeOne = useCallback(async (id) => {
    setNotifications((prev) => prev.filter((n) => (n._id || n.id) !== id));
    try {
      await deleteNotification(id);
    } catch {
      /* reconcile on next fetch */
    }
  }, []);

  const value = useMemo(
    () => ({
      notifications,
      unreadCount,
      loading,
      error,
      pagination,
      refresh,
      markRead,
      markAllRead,
      removeOne,
    }),
    [notifications, unreadCount, loading, error, pagination, refresh, markRead, markAllRead, removeOne]
  );

  return (
    <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>
  );
};
