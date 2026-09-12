import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import api from '../../services/api';
import MapComponent from '../../components/MapComponent';
import ChatPanel from '../../components/ChatPanel';
import { getSocket } from '../../services/socket';
import { useTranslation } from 'react-i18next';
import toast from 'react-hot-toast';
import { COMPLAINT_CATEGORIES, PREFERRED_RESOLUTIONS } from '../../utils/complaints';

const TRACKING_STATUSES = ['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'];
const PAYABLE_STATUSES = ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS', 'COMPLETED'];

const loadRazorpayScript = (src = 'https://checkout.razorpay.com/v1/checkout.js') =>
  new Promise((resolve, reject) => {
    if (window.Razorpay) return resolve(true);
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve(true);
    s.onerror = () => reject(new Error('Could not load the payment gateway. Please try again.'));
    document.body.appendChild(s);
  });

const isValidCoords = (c) =>
  Array.isArray(c) &&
  c.length === 2 &&
  typeof c[0] === 'number' &&
  typeof c[1] === 'number' &&
  Number.isFinite(c[0]) &&
  Number.isFinite(c[1]);

const haversineKm = (coords, coords2) => {
  const [lng1, lat1] = coords;
  const [lng2, lat2] = coords2;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

export default function BookingDetails() {
  const { id } = useParams();
  const { t, i18n } = useTranslation();
  const [booking, setBooking] = useState(null);
  const [loading, setLoading] = useState(true);
  const [workerLocation, setWorkerLocation] = useState(null);
  const [syncedAt, setSyncedAt] = useState(null);
  const [showComplaint, setShowComplaint] = useState(false);
  const [complaintForm, setComplaintForm] = useState({ category: '', description: '', preferredResolution: 'FULL_REFUND' });
  const [complaintFiles, setComplaintFiles] = useState([]);
  const [filingComplaint, setFilingComplaint] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [paying, setPaying] = useState(false);
  const [showCancel, setShowCancel] = useState(false);
  const [cancelReasons, setCancelReasons] = useState([]);
  const [cancelConfig, setCancelConfig] = useState(null);
  const [cancelReasonKey, setCancelReasonKey] = useState('');
  const [cancelPreview, setCancelPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  const canPay =
    !!booking &&
    booking.paymentStatus !== 'PAID' &&
    booking.paymentStatus !== 'REFUNDED' &&
    PAYABLE_STATUSES.includes(booking.status);

  const chatEnabled = !!booking && !!booking.worker &&
    ['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS', 'COMPLETED'].includes(booking.status);

  const load = async () => {
    try {
      const res = await api.get(`/customers/bookings/${id}`);
      setBooking(res.data);
      if (isValidCoords(res.data.workerLocation?.coordinates)) {
        setWorkerLocation(res.data.workerLocation.coordinates);
        setSyncedAt(new Date());
      }
    } catch (e) {
      toast.error(t('book.noDetails'));
    }
    setLoading(false);
  };

  useEffect(() => { load(); }, [id]);

  const trackingActive = !!booking && booking.worker && TRACKING_STATUSES.includes(booking.status);
  useEffect(() => {
    if (!trackingActive) return;
    const poll = async () => {
      try {
        const res = await api.get(`/customers/bookings/${id}`);
        setBooking(res.data);
        if (isValidCoords(res.data.workerLocation?.coordinates)) {
          setWorkerLocation(res.data.workerLocation.coordinates);
          setSyncedAt(new Date());
        }
      } catch { /* ignore */ }
    };
    const t2 = setInterval(poll, 15000);
    return () => clearInterval(t2);
  }, [trackingActive, id]);

  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const handler = (d) => {
      if (d.bookingId === id) {
        if (isValidCoords(d.coordinates)) {
          setWorkerLocation(d.coordinates);
          setSyncedAt(new Date());
        } else {
          load();
        }
      }
    };
    socket.on('worker_location', handler);
    socket.on('booking_update', handler);
    socket.on('material_request_update', handler);
    return () => {
      socket.off('worker_location', handler);
      socket.off('booking_update', handler);
      socket.off('material_request_update', handler);
    };
  }, [id]);

  const handleConfirm = async () => {
    try {
      await api.post(`/customers/bookings/${id}/confirm`);
      toast.success(t('active.completeConfirm'));
      load();
    } catch (err) {
      toast.error(err.message || t('book.noDetails'));
    }
  };

  const handlePay = async () => {
    try {
      setPaying(true);
      const res = await api.post('/payments/create-order', { bookingId: id });
      if (!res.success) throw new Error(res.message || 'Could not create the payment order');
      const { gateway, key, order, paymentId } = res.data;

      if (gateway === 'mock') {
        const ver = await api.post('/payments/verify', {
          razorpay_order_id: order.id,
          razorpay_payment_id: `mock_${paymentId}_${Date.now()}`,
          razorpay_signature: 'mock',
        });
        toast.success(ver.message || t('earn.completed'));
        load();
        return;
      }

      await loadRazorpayScript();
      const options = {
        key,
        amount: order.amount,
        currency: order.currency,
        name: 'ShramikSetu Cooperative',
        description: t('book.bookingNumber', { number: booking.bookingNumber }),
        order_id: order.id,
        handler: async (response) => {
          try {
            const ver = await api.post('/payments/verify', {
              razorpay_order_id: response.razorpay_order_id,
              razorpay_payment_id: response.razorpay_payment_id,
              razorpay_signature: response.razorpay_signature,
            });
            toast.success(ver.message || t('book.payNow'));
            load();
          } catch (e) {
            toast.error(e.message || t('book.noDetails'));
          }
        },
        theme: { color: '#0f766e' },
        modal: { ondismiss: () => {} },
      };
      const rzp = new window.Razorpay(options);
      rzp.on('payment.failed', (r) => {
        toast.error(r?.error?.description || t('book.noDetails'));
      });
      rzp.open();
    } catch (err) {
      toast.error(err.message || t('book.noDetails'));
    } finally {
      setPaying(false);
    }
  };

  const openCancel = async () => {
    setCancelPreview(null);
    setCancelReasonKey('');
    setShowCancel(true);
    try {
      const reasonsRes = await api.get('/cancellations/reasons');
      setCancelReasons(reasonsRes.data?.reasons?.customer || []);
      setCancelConfig(reasonsRes.data?.config || null);
    } catch (e) {
      // reasons/config are enrichment only; fall back to defaults on failure
      setCancelReasons([
        { key: 'changed_mind', label: 'Changed my mind', eligible: true },
        { key: 'no_longer_need', label: 'No longer need service', eligible: true },
        { key: 'worker_delayed', label: 'Worker is delayed', eligible: false },
        { key: 'worker_asked_cancel', label: 'Worker asked me to cancel', eligible: false },
        { key: 'emergency', label: 'Emergency', eligible: false },
        { key: 'found_other_solution', label: 'Found another solution', eligible: true },
        { key: 'other', label: 'Other', eligible: true },
      ]);
    }
  };

  const previewCancel = async (key) => {
    setCancelReasonKey(key);
    if (!key) {
      setCancelPreview(null);
      return;
    }
    setPreviewing(true);
    try {
      const res = await api.post(`/customers/bookings/${id}/cancel-preview`, { reasonKey: key });
      setCancelPreview(res.data?.outcome || null);
    } catch (err) {
      setCancelPreview(null);
      toast.error(err.message || t('toast.unknownError'));
    } finally {
      setPreviewing(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelReasonKey) return;
    setCancelling(true);
    try {
      await api.put(`/customers/bookings/${id}/cancel`, { reasonKey: cancelReasonKey });
      toast.success(t('toast.cancelSuccess'));
      setShowCancel(false);
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    } finally {
      setCancelling(false);
    }
  };

  const handleReassign = async () => {
    try {
      const res = await api.post(`/customers/bookings/${id}/reassign`);
      if (res.success) {
        toast.success(t('book.reassignLooking'));
      } else {
        toast.error(res.message || t('book.noReplacement'));
      }
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const handleApproveMaterial = async (requestId) => {
    try {
      await api.post(`/customers/bookings/${id}/material-request/${requestId}/approve`);
      toast.success(t('book.materialApproved'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const handleRejectMaterial = async (requestId) => {
    try {
      await api.post(`/customers/bookings/${id}/material-request/${requestId}/reject`);
      toast.success(t('book.materialRejected'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const handleReview = async (quality) => {
    try {
      await api.post('/reviews', {
        bookingId: id,
        reviewType: 'CUSTOMER_TO_WORKER',
        overallQuality: quality,
        punctuality: quality,
        behaviour: quality,
        pricing: quality,
        comment: 'Great service!',
      });
      toast.success(t('book.reviewSubmitted'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const submitComplaint = async (e) => {
    e.preventDefault();
    if (!complaintForm.category || !complaintForm.description.trim()) {
      toast.error(t('compl.requiredCategoryDesc'));
      return;
    }
    try {
      setFilingComplaint(true);
      const fd = new FormData();
      fd.append('bookingId', id);
      fd.append('category', complaintForm.category);
      fd.append('description', complaintForm.description.trim());
      fd.append('preferredResolution', complaintForm.preferredResolution);
      complaintFiles.forEach((f, i) => fd.append('evidence', f));
      await api.post('/complaints', fd);
      toast.success(t('compl.complaintFiled'));
      setShowComplaint(false);
      setComplaintForm({ category: '', description: '', preferredResolution: 'FULL_REFUND' });
      setComplaintFiles([]);
      load();
    } catch (err) {
      toast.error(err.message || t('compl.complaintFailed'));
    } finally {
      setFilingComplaint(false);
    }
  };

  if (loading) {
    return <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div></div>;
  }

  if (!booking) {
    return <div className="text-center py-20 text-gray-400">{t('book.noDetails')}</div>;
  }

  const statusColors = {
    REQUESTED: 'bg-gray-100 text-gray-700', MATCHING: 'bg-blue-100 text-blue-700',
    ASSIGNED: 'bg-blue-100 text-blue-700', ACCEPTED: 'bg-green-100 text-green-700',
    ON_THE_WAY: 'bg-green-100 text-green-700', WORKER_ARRIVED: 'bg-green-100 text-green-700',
    STARTED: 'bg-green-100 text-green-700', IN_PROGRESS: 'bg-green-100 text-green-700',
    COMPLETED: 'bg-green-100 text-green-700', CANCELLED: 'bg-red-100 text-red-700',
    DISPUTED: 'bg-yellow-100 text-yellow-700',
    WORKER_NO_SHOW: 'bg-red-100 text-red-700', EXPIRED: 'bg-red-100 text-red-700',
    REASSIGNED: 'bg-yellow-100 text-yellow-700',
  };

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h2 className="text-xl font-bold text-gray-900">{t('book.details')}</h2>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-bold">{booking.serviceSnapshot?.name}</h3>
            <p className="text-sm text-gray-500">{booking.bookingNumber} • {booking.serviceSnapshot?.category}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`badge px-3 py-1 ${statusColors[booking.status]}`}>{t(`status.${booking.status}`)}</span>
            {booking.paymentStatus && booking.paymentStatus !== 'UNPAID' && (
              <span className={`badge px-3 py-1 ${
                booking.paymentStatus === 'PAID'
                  ? 'bg-emerald-100 text-emerald-700'
                  : booking.paymentStatus === 'REFUNDED'
                  ? 'bg-orange-100 text-orange-700'
                  : booking.paymentStatus === 'FAILED'
                  ? 'bg-red-100 text-red-700'
                  : 'bg-gray-100 text-gray-600'
              }`}>
                {booking.paymentStatus === 'PAID' ? t('book.paymentReceived') : booking.paymentStatus}
              </span>
            )}
          </div>
        </div>

        {booking.isEmergency && (
          <div className="p-2 bg-orange-50 rounded-lg mb-4 text-sm text-orange-700 font-medium">
            ⚡ {t('book.emergencyCard', { type: booking.emergencyType || t('book.notSpecified') })}
          </div>
        )}

        <div className="grid grid-cols-2 gap-4 text-sm text-gray-600">
          <div>
            <p className="font-medium">{t('book.dateTime')}:</p>
            <p>{new Date(booking.requestedDate).toLocaleString()}</p>
            <p>{booking.timeSlot}</p>
          </div>
          <div>
            <p className="font-medium">{t('book.location')}:</p>
            <p>{booking.address || t('book.notProvided')}</p>
          </div>
        </div>

        {booking.description && (
          <div className="mt-4">
            <p className="font-medium text-sm text-gray-600 mb-1">{t('book.description')}:</p>
            <p className="text-sm text-gray-500">{booking.description}</p>
          </div>
        )}
      </div>

      {['WORKER_NO_SHOW', 'REASSIGNED', 'EXPIRED'].includes(booking.status) && (
        <div className="card border-red-200 bg-red-50/50">
          <div className="flex items-start gap-3">
            <span className="text-2xl">🙁</span>
            <div className="flex-1">
              <h4 className="font-semibold text-red-700">
                {booking.status === 'WORKER_NO_SHOW'
                  ? t('book.noShowTitle')
                  : booking.status === 'REASSIGNED'
                  ? t('book.reassignTitle')
                  : t('book.expiredTitle')}
              </h4>
              <p className="text-sm text-gray-600 mt-1">
                {t('book.noShowBody')}
              </p>
              <div className="flex flex-wrap gap-3 mt-4">
                <button onClick={handleReassign} className="btn-primary text-sm">
                  🔄 {t('book.findAnotherWorker')}
                </button>
                <button onClick={openCancel} className="btn-danger text-sm">
                  ✕ {t('book.cancelRefund')}
                </button>
                <button onClick={() => setShowComplaint(true)} className="btn-secondary text-sm">
                  📞 {t('book.contactSupport')}
                </button>
                {(booking.failedJobReason || booking.noShowDetectedAt) && (
                  <span className="text-xs text-gray-400 self-center">
                    {booking.noShowDetectedAt
                      ? `${t('book.noShowDetected')} ${new Date(booking.noShowDetectedAt).toLocaleString()}`
                      : ''}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {booking.worker && (
        <div className="card">
          <h4 className="font-semibold mb-2">{t('book.assignedWorker')}</h4>
          <p className="text-sm text-gray-600">{t('book.workerId')}: {booking.worker._id}</p>
          <p className="text-sm text-gray-600">{t('book.verification')}: {booking.worker.verificationStatus}</p>
          {booking.worker.rating > 0 && (
            <p className="text-sm text-gray-600">{t('book.rating')}: ⭐ {booking.worker.rating?.toFixed(1)} ({booking.worker.ratingCount})</p>
          )}
          {booking.matchScore && (
            <p className="text-sm text-gray-600">{t('book.matchScore')}: {booking.matchScore}/100</p>
          )}
        </div>
      )}

      {booking.worker && TRACKING_STATUSES.includes(booking.status) && booking.location?.coordinates && (
        <div className="card border-green-200">
          <h4 className="font-semibold mb-1">📍 {t('book.liveTracking')}</h4>
          <p className="text-xs text-gray-500 mb-3">
            {t('book.liveTrackingHint')}
          </p>
          <MapComponent
            center={
              workerLocation
                ? [workerLocation[1], workerLocation[0]]
                : [booking.location.coordinates[1], booking.location.coordinates[0]]
            }
            markers={[
              { lat: booking.location.coordinates[1], lng: booking.location.coordinates[0], label: t('book.serviceLocation') },
              ...(workerLocation
                ? [{ lat: workerLocation[1], lng: workerLocation[0], type: 'worker', label: t('roles.worker') }]
                : []),
            ]}
            height="240px"
            zoom={14}
          />
          <div className="mt-2">
            {workerLocation ? (
              <p className="text-xs text-gray-500">
                {t('book.lastUpdate')}: {syncedAt?.toLocaleTimeString()}
                {workerLocation && booking.location?.coordinates
                  ? ` • ~${haversineKm(booking.location.coordinates, workerLocation).toFixed(1)} ${t('common.kmAway')}`
                  : ''}
              </p>
            ) : (
              <p className="text-xs text-gray-400">{t('book.waitingLocation')}</p>
            )}
          </div>
        </div>
      )}

      {['MATCHING', 'REASSIGNED'].includes(booking.status) && booking.candidateWorkers?.length > 0 && (
        <div className="card">
          <h4 className="font-semibold mb-2">
            {booking.status === 'REASSIGNED' ? t('book.replacementWorkers') : t('book.matchedWorkers')}
          </h4>
          <div className="space-y-2">
            {booking.candidateWorkers.map((c, i) => (
              <div key={i} className="p-2 bg-gray-50 rounded-lg text-sm">
                <p>Score: {c.score}/100</p>
                <p className="text-xs text-gray-500">{c.reasons?.join(' • ')}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {booking.priceBreakdown && (
        <div className="card">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-semibold">{t('book.paymentSummary')}</h4>
            {booking.paymentStatus === 'PAID' && (
              <span className="badge bg-emerald-100 text-emerald-700">✓ {t('book.paidLabel')}</span>
            )}
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between"><span className="text-gray-600">{t('book.serviceCharge2')}</span><span>₹{booking.priceBreakdown.labour || 0}</span></div>
            <div className="flex justify-between"><span className="text-gray-600">{t('book.materialCost')}</span><span>₹{booking.priceBreakdown.materials || 0}</span></div>
            <div className="flex justify-between text-gray-400">
              <span>{t('book.feesNote')}</span><span>{t('common.included')}</span>
            </div>
            <hr className="border-gray-200" />
            <div className="flex justify-between font-bold"><span>{t('book.totalInclusive')}</span><span className="text-brand-600">₹{booking.priceBreakdown.total || 0}</span></div>
          </div>
          {booking.priceBreakdown.materials > 0 && (
            <p className="text-xs text-gray-400 mt-2">
              {t('book.materialNoteAfterApproval')}
            </p>
          )}
          {canPay && (
            <button
              onClick={handlePay}
              disabled={paying}
              className="btn-primary w-full mt-4 flex items-center justify-center gap-2"
            >
              {paying ? t('book.processingPayment') : t('book.paySecurely', { amount: booking.priceBreakdown.total || 0 })}
            </button>
          )}
          {booking.paymentStatus === 'PAID' && (
            <p className="text-xs text-emerald-600 mt-3">
              {t('book.paymentHeldNote')}
            </p>
          )}
        </div>
      )}

      {Array.isArray(booking.materialRequests) && booking.materialRequests.length > 0 && (
        <div className="card">
          <h4 className="font-semibold mb-3">{t('book.materialRequests')}</h4>
          <div className="space-y-3">
            {booking.materialRequests.map((mr) => {
              const isPending = mr.status === 'pending';
              const isApproved = mr.status === 'approved';
              const isRejected = mr.status === 'rejected';
              return (
                <div key={mr._id} className={`p-3 rounded-lg border ${isPending ? 'border-yellow-300 bg-yellow-50' : isApproved ? 'border-green-200 bg-green-50' : 'border-gray-200 bg-gray-50'}`}>
                  <div className="flex items-center justify-between">
                    <p className="font-medium text-sm">{mr.description}</p>
                    <span className={`badge ${isPending ? 'badge-warning' : isApproved ? 'badge-success' : 'badge-gray'}`}>
                      {isPending ? t('active.pendingApproval') : isApproved ? t('common.confirm') : t('common.cancelled')}
                    </span>
                  </div>
                  <p className="text-sm mt-1">{t('book.costLabel')}: ₹{mr.amount}</p>
                  {mr.note && <p className="text-xs text-gray-500 mt-1">Note: {mr.note}</p>}
                  {mr.requestedAt && (
                    <p className="text-xs text-gray-400 mt-1">{t('book.requestedAt')}: {new Date(mr.requestedAt).toLocaleString()}</p>
                  )}
                  {isPending && (
                    <div className="mt-3 p-3 rounded-lg bg-white border border-gray-200">
                      <p className="font-semibold text-sm text-gray-900">{t('book.additionalMaterialRequired')}</p>
                      <p className="text-sm mt-1">{t('book.materialName')}: {mr.description}</p>
                      <p className="text-sm">{t('book.costLabel')}: ₹{mr.amount}</p>
                      <p className="text-sm">{t('book.currentCharge')}: ₹{booking.priceBreakdown?.labour || 0}</p>
                      <p className="text-sm">{t('book.newTotal')}: ₹{(booking.priceBreakdown?.labour || 0) + mr.amount}</p>
                      <div className="flex gap-2 mt-3">
                        <button onClick={() => handleApproveMaterial(mr._id)} className="btn-success text-sm">✓ {t('common.confirm')}</button>
                        <button onClick={() => handleRejectMaterial(mr._id)} className="btn-danger text-sm">✕ {t('common.cancel')}</button>
                      </div>
                      <p className="text-xs text-gray-400 mt-2">
                        {t('book.materialDecisionNote')}
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {booking.location?.coordinates && (
        <div className="card">
          <h4 className="font-semibold mb-3">{t('book.location')}</h4>
          <MapComponent
            center={[booking.location.coordinates[1], booking.location.coordinates[0]]}
            markers={[{
              lat: booking.location.coordinates[1],
              lng: booking.location.coordinates[0],
              label: t('book.serviceLocation'),
            }]}
            height="200px"
            zoom={15}
          />
        </div>
      )}

      <div className="card">
        <h4 className="font-semibold mb-3">{t('book.actions')}</h4>
        <div className="flex flex-wrap gap-3">
          {booking.status === 'COMPLETED' && booking.paymentStatus === 'PAID' && (
            <button onClick={handleConfirm} className="btn-success text-sm">{t('book.confirmCompletion')}</button>
          )}
          {canPay && (
            <button onClick={handlePay} disabled={paying} className="btn-primary text-sm">
              {paying ? t('common.loading') : t('book.payNow')}
            </button>
          )}
          {['REQUESTED', 'MATCHING', 'ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(booking.status) && (
            <button onClick={openCancel} className="btn-danger text-sm">{t('book.cancelBooking')}</button>
          )}
          {booking.status === 'COMPLETED' && (
            <button onClick={() => handleReview(5)} className="btn-accent text-sm">⭐ {t('book.rate5')}</button>
          )}
          {booking.status === 'COMPLETED' && (
            <button onClick={() => setShowComplaint(true)} className="btn-secondary text-sm">⚠ {t('compl.fileComplaint')}</button>
          )}
        </div>
      </div>

      {booking.statusHistory?.length > 0 && (
        <div className="card">
          <h4 className="font-semibold mb-3">{t('book.statusHistory')}</h4>
          <div className="space-y-3">
            {booking.statusHistory.map((sh, i) => (
              <div key={i} className="flex items-center gap-3">
                <div className="w-2 h-2 bg-brand-600 rounded-full mt-1"></div>
                <div>
                  <p className="text-sm font-medium">{t(`status.${sh.status}`, sh.status)}</p>
                  <p className="text-xs text-gray-500">{new Date(sh.updatedAt).toLocaleString()}</p>
                  {sh.note && <p className="text-xs text-gray-400">{sh.note}</p>}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {showComplaint && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">{t('compl.fileComplaint')}</h3>
              <button onClick={() => setShowComplaint(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <form onSubmit={submitComplaint} className="p-6 space-y-4">
              <p className="text-sm text-gray-500">
                {t('compl.bookingRef', { number: booking.bookingNumber })}
              </p>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('compl.category')} *</label>
                <select
                  value={complaintForm.category}
                  onChange={(e) => setComplaintForm({ ...complaintForm, category: e.target.value })}
                  className="input-field mt-1"
                >
                  <option value="">{t('common.submit') === 'Submit' ? t('create.selectType') : t('create.selectType')}</option>
                  {COMPLAINT_CATEGORIES.map((c) => (
                    <option key={c.value} value={c.value}>{t(`compl.categories.${c.value}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('compl.describeIssue')} *</label>
                <textarea
                  value={complaintForm.description}
                  onChange={(e) => setComplaintForm({ ...complaintForm, description: e.target.value })}
                  rows={4}
                  maxLength={2000}
                  className="input-field mt-1"
                  placeholder={t('compl.issuePlaceholder')}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('compl.whatResolves')}</label>
                <select
                  value={complaintForm.preferredResolution}
                  onChange={(e) => setComplaintForm({ ...complaintForm, preferredResolution: e.target.value })}
                  className="input-field mt-1"
                >
                  {PREFERRED_RESOLUTIONS.map((r) => (
                    <option key={r.value} value={r.value}>{t(`compl.resolutions.${r.value}`)}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('compl.evidence')}</label>
                <input
                  type="file"
                  multiple
                  accept="image/*,.pdf,video/mp4,video/quicktime"
                  onChange={(e) => setComplaintFiles([...e.target.files])}
                  className="mt-1 w-full text-sm text-gray-500 file:mr-3 file:px-3 file:py-1.5 file:rounded-lg file:border-0 file:bg-brand-50 file:text-brand-700 file:text-sm file:font-medium"
                />
                {complaintFiles.length > 0 && (
                  <p className="text-xs text-gray-500 mt-1">{t('compl.selectedFiles', { count: complaintFiles.length })}</p>
                )}
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowComplaint(false)} className="btn-secondary text-sm">{t('common.cancel')}</button>
                <button type="submit" disabled={filingComplaint} className="btn-primary text-sm">
                  {filingComplaint ? t('compl.filing') : t('compl.submitComplaint')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
      {showCancel && booking && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">{t('cancel.title', 'Cancel booking')}</h3>
              <button onClick={() => setShowCancel(false)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6 space-y-5">
              {cancelConfig && cancelConfig.freeCancelBeforeAccept && ['REQUESTED', 'MATCHING'].includes(booking.status) && (
                <div className="rounded-lg bg-green-50 border border-green-200 px-4 py-3 text-sm text-green-800">
                  {t('cancel.freeBeforeAccept', 'No cancellation fee applies before a worker accepts your request.')}
                </div>
              )}
              <div>
                <label className="text-xs font-medium text-gray-600">{t('cancel.reasonLabel', 'Why are you cancelling?')} *</label>
                <select
                  value={cancelReasonKey}
                  onChange={(e) => previewCancel(e.target.value)}
                  className="input-field mt-1"
                >
                  <option value="">{t('cancel.selectReason', 'Select a reason')}</option>
                  {cancelReasons.map((r) => (
                    <option key={r.key} value={r.key}>{t(`cancel.reasons.${r.key}`, r.label)}</option>
                  ))}
                </select>
              </div>

              {previewing && <p className="text-sm text-gray-500">{t('common.loading')}</p>}

              {!previewing && cancelPreview && (
                <div className="space-y-2 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
                  {cancelPreview.freePreAccept || cancelPreview.customerPenaltyAmount === 0 ? (
                    <p className="text-sm text-green-700">
                      {t('cancel.noFee', 'No cancellation fee will be charged.')}
                    </p>
                  ) : (
                    <p className="text-sm">
                      <span className="text-gray-700">{t('cancel.feeLabel', 'Cancellation fee')}:</span>{' '}
                      <span className="font-semibold text-red-600">₹{cancelPreview.customerPenaltyAmount}</span>
                      <span className="text-gray-500 block text-xs mt-1">
                        {t('cancel.feeNextBooking', 'This amount is carried to your next booking and collected with its payment.')}
                      </span>
                    </p>
                  )}
                  {cancelPreview.workerCompensationAmount > 0 && (
                    <p className="text-sm text-amber-700">
                      {t('cancel.workerCompensation', 'The worker will be compensated ₹{{amount}} for travel.', {
                        amount: cancelPreview.workerCompensationAmount,
                      })}
                    </p>
                  )}
                </div>
              )}

              {cancelReasonKey && (
                <div className="text-xs text-gray-500">
                  {t('cancel.threshold', 'Repeated eligible cancellations can lead to a temporary account suspension.', {})}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setShowCancel(false)} className="btn-secondary text-sm">{t('common.cancel')}</button>
                <button
                  type="button"
                  onClick={confirmCancel}
                  disabled={!cancelReasonKey || previewing || cancelling}
                  className="btn-danger text-sm"
                >
                  {cancelling ? t('common.loading') : t('book.cancelBooking')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      {chatEnabled && (
        <>
          <button
            onClick={() => setChatOpen(true)}
            className="fixed bottom-6 right-6 z-40 flex items-center gap-2 rounded-full bg-brand-600 px-5 py-3 text-white shadow-lg hover:bg-brand-700 transition"
          >
            <span>💬</span> {t('book.messageWorker')}
          </button>
          <ChatPanel bookingId={id} open={chatOpen} onClose={() => setChatOpen(false)} bookingNumber={booking.bookingNumber} />
        </>
      )}
    </div>
  );
}