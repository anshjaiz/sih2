const Notification = require('../../models/Notification');
const {
  asyncHandler,
  ApiError,
} = require('../../middleware/errorMiddleware');

// Get the authenticated user's notifications (paginated, newest first).
// Recipient is ALWAYS the JWT-authenticated user — never client-supplied.
const getMyNotifications = asyncHandler(async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 50);
  const skip = (page - 1) * limit;

  const where = { user: req.user._id };
  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(where).sort({ createdAt: -1 }).skip(skip).limit(limit),
    Notification.countDocuments(where),
    Notification.countDocuments({ ...where, isRead: false }),
  ]);

  res.json({
    success: true,
    data: notifications,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
    unreadCount,
  });
});

// Get unread count
const getUnreadCount = asyncHandler(async (req, res) => {
  const count = await Notification.countDocuments({
    user: req.user._id,
    isRead: false,
  });
  res.json({ success: true, data: { count } });
});

// Mark all as read
const markAllRead = asyncHandler(async (req, res) => {
  await Notification.updateMany(
    { user: req.user._id, isRead: false },
    { isRead: true, readAt: new Date() }
  );
  res.json({ success: true, message: 'All notifications marked as read' });
});

// Mark single as read
const markRead = asyncHandler(async (req, res) => {
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, user: req.user._id },
    { isRead: true, readAt: new Date() },
    { new: true }
  );
  if (!notification) throw new ApiError('Notification not found', 404);
  res.json({ success: true, data: notification });
});

// Delete a single notification (scoped to the authenticated user).
const deleteNotification = asyncHandler(async (req, res) => {
  const notif = await Notification.findOneAndDelete({
    _id: req.params.id,
    user: req.user._id,
  });
  if (!notif) throw new ApiError('Notification not found', 404);
  res.json({ success: true, message: 'Notification deleted', data: notif });
});

// Delete all of the authenticated user's notifications.
const deleteAllNotifications = asyncHandler(async (req, res) => {
  await Notification.deleteMany({ user: req.user._id });
  res.json({ success: true, message: 'All notifications deleted' });
});

module.exports = {
  getMyNotifications,
  getUnreadCount,
  markAllRead,
  markRead,
  deleteNotification,
  deleteAllNotifications,
};
