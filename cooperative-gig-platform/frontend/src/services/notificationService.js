import api from './api';

/**
 * Notification API wrapper — all endpoints resolve to the JWT-authenticated
 * user's own notifications; the recipient is NEVER client-supplied.
 *
 * The backend `getMyNotifications` returns `{ success, data, pagination,
 * unreadCount }` where `data` is the page of notifications.
 */
export const getMyNotifications = async ({ page = 1, limit = 15 } = {}) => {
  const res = await api.get('/notifications', { params: { page, limit } });
  return res;
};

export const getUnreadCount = async () => {
  const res = await api.get('/notifications/unread-count');
  return res;
};

export const markAllAsRead = async () => {
  const res = await api.put('/notifications/read-all');
  return res;
};

export const markAsRead = async (id) => {
  const res = await api.put(`/notifications/${id}/read`);
  return res;
};

export const deleteNotification = async (id) => {
  const res = await api.delete(`/notifications/${id}`);
  return res;
};

export const deleteAllNotifications = async () => {
  const res = await api.delete('/notifications');
  return res;
};
