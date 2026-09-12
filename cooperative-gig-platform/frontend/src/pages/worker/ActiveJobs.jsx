import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import api from '../../services/api';
import toast from 'react-hot-toast';
import { getSocket } from '../../services/socket';
import { getJobTeam, getRequestsForBooking } from '../../services/collaboratorService';
import RequestCollaboratorModal from '../../components/collaborator/RequestCollaboratorModal';
import JobTeamCard from '../../components/collaborator/JobTeamCard';
import ChatPanel from '../../components/ChatPanel';
import NavigationPanel from '../../components/worker/NavigationPanel';

export default function ActiveJobs() {
  const { t } = useTranslation();
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [teams, setTeams] = useState({});
  const [requests, setRequests] = useState({});
  const [helperLocs, setHelperLocs] = useState({});
  const [requestingFor, setRequestingFor] = useState(null);
  const [chatJob, setChatJob] = useState(null);
  const [navJob, setNavJob] = useState(null);
  const [materialJob, setMaterialJob] = useState(null);
  const [materialForm, setMaterialForm] = useState({ description: '', amount: '', note: '' });
  const [materialSubmitting, setMaterialSubmitting] = useState(false);
  const [cancelFor, setCancelFor] = useState(null);
  const [cancelReasons, setCancelReasons] = useState([]);
  const [cancelReasonKey, setCancelReasonKey] = useState('');
  const [cancelPreview, setCancelPreview] = useState(null);
  const [previewing, setPreviewing] = useState(false);
  const [cancelling, setCancelling] = useState(false);

  // Server-gated start time: the UI re-checks every 30s so the Start button
  // unlocks automatically the moment the scheduled start time arrives.
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(t);
  }, []);

  const getStartTime = (job) => {
    const raw = job.effectiveScheduledStartTime || job.scheduledStartTime;
    return raw ? new Date(raw) : null;
  };

  const getNavTime = (job) => {
    const raw = job.effectiveNavigationAvailableTime || job.navigationAvailableTime;
    return raw ? new Date(raw) : null;
  };

  const formatTimeLabel = (date) => {
    const d = new Date(date);
    let h = d.getHours();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const m = String(d.getMinutes()).padStart(2, '0');
    return `${h}:${m} ${ampm}`;
  };

  const canStart = (job) => {
    const start = getStartTime(job);
    return !start || nowMs >= start.getTime();
  };

  const canNavigate = (job) => {
    const t = getNavTime(job);
    return !t || nowMs >= t.getTime();
  };

  const navDurationTxt = (mins) => {
    if (mins == null || mins % 60 !== 0) return `${mins || 60} minutes`;
    const h = mins / 60;
    return h === 1 ? '1 hour' : `${h} hours`;
  };

  const renderNavigationButton = (job) => {
    const available = canNavigate(job);
    const start = getStartTime(job);
    return (
      <div className="flex-1">
        {!available && (
          <p className="text-xs text-gray-500 mb-1 text-center">
            {t('active.availableBeforeJob', { duration: navDurationTxt(job.navigationBufferMinutes) })}
          </p>
        )}
        {available && !canStart(job) && start && (
          <p className="text-xs text-gray-500 mb-1 text-center">
            {t('active.jobStartsAt', { time: formatTimeLabel(start) })}
          </p>
        )}
        <button
          onClick={() => handleStartNav(job._id)}
          disabled={!available}
          className={`btn-primary w-full ${available ? '' : 'opacity-60 cursor-not-allowed'}`}
        >
          {available ? `🧭 ${t('active.navigateToCustomer')}` : `🔒 ${t('active.navigateToCustomer')}`}
        </button>
      </div>
    );
  };

  const renderStartButton = (job) => {
    const ready = canStart(job);
    const start = getStartTime(job);
    return (
      <div className="flex-1">
        {!ready && start && (
          <p className="text-xs text-gray-500 mb-1 text-center">
            {t('active.startAvailableAt', { time: formatTimeLabel(start) })}
          </p>
        )}
        <button
          onClick={() => handleStatus(job._id, 'STARTED')}
          disabled={!ready}
          className={`btn-primary w-full ${ready ? '' : 'opacity-60 cursor-not-allowed'}`}
        >
          {ready ? `▶️ ${t('active.startWork')}` : `🔒 ${t('active.startWork')}`}
        </button>
      </div>
    );
  };

  const load = async () => {
    try {
      const res = await api.get('/workers/jobs/active');
      setJobs(res.data || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  // Store team [+ seed helper's last-known location from the team record]
  const applyTeam = (bookingId, team) => {
    setTeams((prev) => ({ ...prev, [bookingId]: team }));
    if (team && Array.isArray(team.members)) {
      const seed = {};
      team.members.forEach((m) => {
        if (m.worker && m.location && Array.isArray(m.location.coordinates)) {
          seed[m.worker] = m.location.coordinates;
        }
      });
      if (Object.keys(seed).length) setHelperLocs((prev) => ({ ...prev, ...seed }));
    }
  };

  // Load collaboration team + sent invites for each active job (once per booking)
  useEffect(() => {
    jobs.forEach((job) => {
      if (teams[job._id] === undefined) {
        getJobTeam(job._id)
          .then((res) => applyTeam(job._id, res.data))
          .catch(() => setTeams((prev) => ({ ...prev, [job._id]: null })));
      }
      if (requests[job._id] === undefined) {
        getRequestsForBooking(job._id)
          .then((res) => setRequests((prev) => ({ ...prev, [job._id]: res.data || [] })))
          .catch(() => setRequests((prev) => ({ ...prev, [job._id]: [] })));
      }
    });
  }, [jobs]);

  // Live updates: collaborator accepted/declined on one of my bookings
  useEffect(() => {
    const socket = getSocket();
    if (!socket) return undefined;
    const onUpdate = (payload) => {
      const bookingId = payload?.bookingId || payload?.request?.booking;
      if (bookingId) {
        Promise.all([
          getJobTeam(bookingId).then((res) => res.data).catch(() => null),
          getRequestsForBooking(bookingId).then((res) => res.data || []).catch(() => []),
        ]).then(([team, reqs]) => {
          applyTeam(bookingId, team);
          setRequests((prev) => ({ ...prev, [bookingId]: reqs }));
        });
      }
    };
    socket.on('collaboration_update', onUpdate);
    socket.on('material_request_update', onUpdate);
    socket.on('booking_update', onUpdate);
    const onHelperLoc = (payload) => {
      if (payload?.helperId && Array.isArray(payload?.coordinates)) {
        setHelperLocs((prev) => ({ ...prev, [payload.helperId]: payload.coordinates }));
      }
    };
    socket.on('worker_location', onHelperLoc);
    return () => {
      socket.off('collaboration_update', onUpdate);
      socket.off('worker_location', onHelperLoc);
    };
  }, []);

  // Live location sharing: while an active job is ON_THE_WAY or STARTED,
  // send the worker's location every 10s so the customer can track them.
  const trackingJob = jobs.some((j) => ['ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(j.status));
  useEffect(() => {
    if (!trackingJob) return;
    const send = () => {
      if (!navigator.geolocation) return;
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          api.put('/workers/location', { coordinates: [pos.coords.longitude, pos.coords.latitude] }).catch(() => {});
        },
        () => {},
        { enableHighAccuracy: true, timeout: 8000 }
      );
    };
    send();
    const t = setInterval(send, 10000);
    return () => clearInterval(t);
  }, [trackingJob]);

  const handleStatus = async (id, status) => {
    try {
      await api.post(`/workers/jobs/${id}/status`, { status });
      toast.success(t('toast.statusUpdated'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const handleStartNav = (id) => {
    console.log('START NAVIGATION BUTTON CLICKED', id);
    handleStatus(id, 'ON_THE_WAY');
  };

  const handleComplete = async (id) => {
    try {
      await api.post(`/workers/jobs/${id}/complete`);
      toast.success(t('toast.jobCompleted'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const handleArrive = async (id) => {
    try {
      await api.post(`/workers/jobs/${id}/arrive`);
      toast.success(t('toast.arrivedUpdated'));
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    }
  };

  const openCancel = async (job) => {
    setCancelFor(job);
    setCancelReasonKey('');
    setCancelPreview(null);
    try {
      const res = await api.get('/cancellations/reasons');
      setCancelReasons(res.data?.reasons?.worker || []);
    } catch (e) {
      setCancelReasons([
        { key: 'customer_unavailable', label: 'Customer unavailable', eligible: false },
        { key: 'incorrect_address', label: 'Incorrect address', eligible: false },
        { key: 'unsafe_situation', label: 'Unsafe situation', eligible: false },
        { key: 'customer_requested_cancellation', label: 'Customer requested cancellation', eligible: false },
        { key: 'transport_problem', label: 'Transport problem', eligible: true },
        { key: 'emergency', label: 'Emergency', eligible: false },
        { key: 'other', label: 'Other', eligible: false },
      ]);
    }
  };

  const previewCancel = async (key) => {
    setCancelReasonKey(key);
    if (!key || !cancelFor) {
      setCancelPreview(null);
      return;
    }
    setPreviewing(true);
    try {
      const res = await api.post(`/workers/jobs/${cancelFor._id}/cancel-preview`, { reasonKey: key });
      setCancelPreview(res.data?.outcome || null);
    } catch (err) {
      setCancelPreview(null);
      toast.error(err.message || t('toast.unknownError'));
    } finally {
      setPreviewing(false);
    }
  };

  const confirmCancel = async () => {
    if (!cancelReasonKey || !cancelFor) return;
    setCancelling(true);
    try {
      await api.put(`/workers/jobs/${cancelFor._id}/cancel`, { reasonKey: cancelReasonKey });
      toast.success(t('toast.cancelSuccess'));
      setCancelFor(null);
      load();
    } catch (err) {
      toast.error(err.message || t('toast.unknownError'));
    } finally {
      setCancelling(false);
    }
  };

  const openMaterialModal = (job) => {
    setMaterialForm({ description: '', amount: '', note: '' });
    setMaterialJob(job);
  };

  const handleSubmitMaterial = async (e) => {
    e.preventDefault();
    const amount = parseFloat(materialForm.amount);
    if (!materialForm.description.trim() || !amount || amount <= 0) {
      toast.error(t('active.materialValidation'));
      return;
    }
    setMaterialSubmitting(true);
    try {
      await api.post(`/workers/jobs/${materialJob._id}/material-request`, {
        description: materialForm.description.trim(),
        amount,
        note: materialForm.note.trim(),
      });
      toast.success(t('active.materialSent'));
      setMaterialJob(null);
      load();
    } catch (err) {
      toast.error(err.message || t('active.materialSubmitFailed'));
    } finally {
      setMaterialSubmitting(false);
    }
  };

  const statusFlow = {
    ASSIGNED: 'ACCEPTED',
    ACCEPTED: 'ON_THE_WAY',
    ON_THE_WAY: 'STARTED',
    WORKER_ARRIVED: 'STARTED',
  };

  const statusColors = {
    ASSIGNED: 'bg-blue-100 text-blue-700',
    ACCEPTED: 'bg-green-100 text-green-700',
    ON_THE_WAY: 'bg-green-100 text-green-700',
    WORKER_ARRIVED: 'bg-green-100 text-green-700',
    STARTED: 'bg-green-100 text-green-700',
    IN_PROGRESS: 'bg-green-100 text-green-700',
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-gray-900">{t('active.title')}</h2>

      {loading ? (
        <div className="flex justify-center py-20"><div className="animate-spin rounded-full h-10 w-10 border-b-2 border-brand-600"></div></div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-20 text-gray-400">{t('active.noActiveJobs')}</div>
      ) : (
        <div className="space-y-4">
          {jobs.map((job) => (
            <div key={job._id} className="card">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold">{job.serviceSnapshot?.name}</h3>
                  <p className="text-sm text-gray-500">{job.bookingNumber}</p>
                </div>
                <span className={`badge px-3 py-1 ${statusColors[job.status]}`}>{t(`status.${job.status}`)}</span>
                {['ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status) && (
                  <span className="badge px-3 py-1 bg-red-100 text-red-700">● {t('active.liveOn')}</span>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4 text-sm text-gray-600 mb-4">
                <div>
                  <p className="font-medium">{t('jobs.customer')}: {job.customer?.name}</p>
                  <p>📞 {job.customer?.phone}</p>
                </div>
                <div>
                  <p>📍 {job.address}</p>
                  <p>⏰ {job.timeSlot}</p>
                </div>
              </div>

              {job.description && (
                <p className="text-sm text-gray-500 mb-3 italic">"{job.description}"</p>
              )}

              <div className="flex gap-3">
                  {job.status === 'ASSIGNED' && (
                    <button onClick={() => handleStatus(job._id, 'ACCEPTED')} className="btn-primary flex-1">✅ {t('jobs.accept')}</button>
                  )}
                  {job.status === 'ACCEPTED' && (
                    <>
                      {renderNavigationButton(job)}
                      <button onClick={() => handleArrive(job._id)} className="btn-accent flex-1">📍 {t('active.arrived')}</button>
                    </>
                  )}
                  {job.status === 'ON_THE_WAY' && (
                    <>
                      <button onClick={() => handleArrive(job._id)} className="btn-accent flex-1">📍 {t('active.arrived')}</button>
                      {renderStartButton(job)}
                    </>
                  )}
                  {job.status === 'WORKER_ARRIVED' && (
                    renderStartButton(job)
                  )}
                  {['STARTED', 'IN_PROGRESS'].includes(job.status) && (
                    <button onClick={() => handleComplete(job._id)} className="btn-success flex-1">✓ {t('active.completeJob')}</button>
                  )}
                </div>

                {['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status) && (
                  <button onClick={() => setChatJob(job)} className="btn-secondary text-sm mt-3 w-full">
                    💬 {t('book.messageWorker')}
                  </button>
                )}

                {['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status) && (
                  <button
                    onClick={() => openCancel(job)}
                    className="text-xs font-medium text-red-600 hover:text-red-700 mt-3 underline decoration-dotted underline-offset-2"
                  >
                    {t('active.cancelJob')}
                  </button>
                )}

                {['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status) &&
                  Array.isArray(job.location?.coordinates) && job.location.coordinates.length >= 2 && (
                  <button
                    onClick={() => canNavigate(job) && setNavJob(job)}
                    disabled={!canNavigate(job)}
                    className="btn-secondary text-sm mt-2 w-full border-brand-200 text-brand-700 disabled:opacity-60 disabled:cursor-not-allowed"
                  >
                    {canNavigate(job) ? `🧭 ${t('active.navigateToJob')}` : `🔒 ${t('active.navigateToJob')}`}
                  </button>
                )}

              {/* Price */}
              <div className="mt-4 p-3 bg-gray-50 rounded-lg text-sm">
                <div className="flex justify-between"><span>{t('book.serviceCharge2')}</span><span>₹{job.priceBreakdown?.labour || 0}</span></div>
                <div className="flex justify-between"><span>{t('book.materialCost')} ({t('earn.completed')})</span><span>₹{job.priceBreakdown?.materials || 0}</span></div>
                <div className="flex justify-between"><span>{t('book.feesNote')}</span><span>{t('common.included')}</span></div>
                <div className="flex justify-between font-bold border-t mt-1 pt-1">
                  <span>{t('common.total')}</span><span className="text-brand-600">₹{job.priceBreakdown?.total || 0}</span>
                </div>
              </div>

              {/* Material requests */}
              {Array.isArray(job.materialRequests) && job.materialRequests.length > 0 && (
                <div className="mt-3 space-y-2">
                  {job.materialRequests.map((mr) => (
                    <div
                      key={mr._id}
                      className={`p-2 rounded-lg border text-sm ${
                        mr.status === 'pending'
                          ? 'border-yellow-300 bg-yellow-50'
                          : mr.status === 'approved'
                          ? 'border-green-200 bg-green-50'
                          : 'border-gray-200 bg-gray-50'
                      }`}
                    >
                      <div className="flex items-center justify-between">
                        <p className="font-medium">{mr.description}</p>
                        <span className={`badge ${mr.status === 'pending' ? 'badge-warning' : mr.status === 'approved' ? 'badge-success' : 'badge-gray'}`}>
                          {mr.status === 'pending' ? t('active.pendingApproval') : mr.status === 'approved' ? t('earn.completed') : t('common.cancelled')}
                        </span>
                      </div>
                      <p className="text-xs text-gray-500 mt-0.5">₹{mr.amount}{mr.note ? ` • ${mr.note}` : ''}</p>
                    </div>
                  ))}
                </div>
              )}

              {['ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status) &&
                !(job.materialRequests || []).some((mr) => mr.status === 'pending') && (
                  <button onClick={() => openMaterialModal(job)} className="btn-secondary text-sm mt-3 w-full border-brand-200 text-brand-700">
                    + {t('active.addedMaterialCost')}
                  </button>
                )}

              {/* Collaboration */}
              {(teams[job._id] !== undefined || ['ASSIGNED', 'ACCEPTED', 'ON_THE_WAY', 'WORKER_ARRIVED', 'STARTED', 'IN_PROGRESS'].includes(job.status)) && (
                <div className="mt-4">
                  {teams[job._id] ? (
                    <JobTeamCard team={teams[job._id]} helperLocs={helperLocs} bookingLocation={job.location?.coordinates} />
                  ) : (requests[job._id] || []).length > 0 ? (
                    <div className="p-4 bg-brand-50 rounded-xl">
                      <div className="flex items-center justify-between mb-2">
                        <p className="text-sm font-medium text-gray-700">📨 {t('active.invitationsSent')}</p>
                        <button onClick={() => setRequestingFor(job)} className="text-xs text-brand-600 hover:underline">
                          + {t('active.addMore')}
                        </button>
                      </div>
                      <div className="space-y-2">
                        {requests[job._id].map((req) =>
                          (req.candidates || []).map((c) => (
                            <div key={req._id + c.worker?._id} className="flex items-center justify-between bg-white rounded-lg px-3 py-2">
                              <div>
                                <span className="text-sm font-medium text-gray-800">{c.worker?.user?.name || 'Worker'}</span>
                                <span className="text-xs text-gray-400 ml-1">· {req.role}</span>
                              </div>
                              <div className="flex items-center gap-2">
                                {c.score != null && (
                                  <span className="text-xs text-gray-500">{t('active.matchPct', { pct: Math.round(c.score) })}</span>
                                )}
                                <span className={`badge px-2 py-0.5 ${
                                  c.status === 'ACCEPTED' ? 'bg-green-100 text-green-700'
                                  : c.status === 'DECLINED' ? 'bg-red-100 text-red-600'
                                  : c.status === 'NO_SHOW' ? 'bg-red-100 text-red-600'
                                  : 'bg-yellow-100 text-yellow-700'
                                }`}>
                                  {c.status}
                                </span>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                      <p className="text-[11px] text-gray-400 mt-2">
                        {t('active.inviteNote')} <span className="font-medium">{t('nav.collaborations')}</span>.
                      </p>
                    </div>
                  ) : teams[job._id] === null ? (
                    <div className="flex items-center justify-between p-3 bg-brand-50 rounded-xl">
                      <p className="text-sm text-gray-600">👥 {t('active.noTeamYet')}</p>
                      <button
                        onClick={() => setRequestingFor(job)}
                        className="btn-primary text-sm px-3 py-2"
                      >
                        + {t('active.requestCollab')}
                      </button>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <ChatPanel
        bookingId={chatJob?._id}
        open={chatJob !== null}
        onClose={() => setChatJob(null)}
        bookingNumber={chatJob?.bookingNumber}
      />
      <NavigationPanel
        job={navJob}
        open={navJob !== null}
        onClose={() => setNavJob(null)}
        onExpired={() => {
          setNavJob(null);
          load();
        }}
      />
      <RequestCollaboratorModal
        open={requestingFor !== null}
        booking={requestingFor}
        onClose={() => setRequestingFor(null)}
        onCreated={() => {
          if (requestingFor) {
            Promise.all([
              getJobTeam(requestingFor._id).then((res) => res.data).catch(() => null),
              getRequestsForBooking(requestingFor._id).then((res) => res.data || []).catch(() => []),
            ]).then(([team, reqs]) => {
              applyTeam(requestingFor._id, team);
              setRequests((prev) => ({ ...prev, [requestingFor._id]: reqs }));
            });
          }
        }}
      />

      {/* Add Material Cost modal */}
      {materialJob && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">+ {t('active.addedMaterialCost')}</h3>
              <button onClick={() => setMaterialJob(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <form onSubmit={handleSubmitMaterial} className="p-6 space-y-4">
              <p className="text-sm text-gray-500">
                {t('active.materialModalNote', { service: materialJob.serviceSnapshot?.name, charge: materialJob.priceBreakdown?.labour || 0 })}
              </p>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('active.materialNameLabel')} *</label>
                <input
                  type="text"
                  className="input-field mt-1"
                  placeholder={t('active.materialNamePlaceholder')}
                  value={materialForm.description}
                  onChange={(e) => setMaterialForm({ ...materialForm, description: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('wallet.amount')} (₹) *</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="input-field mt-1"
                  placeholder="e.g., 180"
                  value={materialForm.amount}
                  onChange={(e) => setMaterialForm({ ...materialForm, amount: e.target.value })}
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('active.materialNote')}</label>
                <textarea
                  rows={2}
                  className="input-field mt-1"
                  placeholder={t('active.materialNotePlaceholder')}
                  value={materialForm.note}
                  onChange={(e) => setMaterialForm({ ...materialForm, note: e.target.value })}
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setMaterialJob(null)} className="btn-secondary text-sm">{t('common.cancel')}</button>
                <button type="submit" disabled={materialSubmitting} className="btn-primary text-sm">
                  {materialSubmitting ? t('active.submitting') : t('create.submitRequest')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    {/* Cancel job modal */}
      {cancelFor && (
        <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-100">
              <h3 className="font-bold text-gray-900">{t('cancel.workerTitle', 'Cancel this job')}</h3>
              <button onClick={() => setCancelFor(null)} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
            </div>
            <div className="p-6 space-y-5">
              <p className="text-sm text-gray-500">
                {t('cancel.workerRef', 'Job {{number}} · {{service}}', {
                  number: cancelFor.bookingNumber,
                  service: cancelFor.serviceSnapshot?.name,
                })}
              </p>
              <div>
                <label className="text-xs font-medium text-gray-600">{t('cancel.reasonLabel', 'Why are you cancelling?')} *</label>
                <select
                  value={cancelReasonKey}
                  onChange={(e) => previewCancel(e.target.value)}
                  className="input-field mt-1"
                >
                  <option value="">{t('cancel.selectReason', 'Select a reason')}</option>
                  {cancelReasons.map((r) => (
                    <option key={r.key} value={r.key}>{t(`cancel.workerReasons.${r.key}`, r.label)}</option>
                  ))}
                </select>
              </div>

              {previewing && <p className="text-sm text-gray-500">{t('common.loading')}</p>}

              {!previewing && cancelPreview && (
                <div className="space-y-2 rounded-lg bg-gray-50 border border-gray-200 px-4 py-3">
                  {cancelPreview.workerMeritPoints === 0 ? (
                    <p className="text-sm text-green-700">
                      {t('cancel.workerNoPenalty', 'No merit deduction applies for this reason.')}
                    </p>
                  ) : (
                    <p className="text-sm">
                      <span className="text-gray-700">{t('cancel.workerMeritLabel', 'Merit deduction')}:</span>{' '}
                      <span className="font-semibold text-red-600">{cancelPreview.workerMeritPoints} pts</span>
                    </p>
                  )}
                  {cancelPreview.workerCompensationAmount > 0 && (
                    <p className="text-sm text-amber-700">
                      {t('cancel.workerCompensation', 'The customer will pay ₹{{amount}} travel compensation.', {
                        amount: cancelPreview.workerCompensationAmount,
                      })}
                    </p>
                  )}
                </div>
              )}

              <div className="flex justify-end gap-3 pt-2">
                <button type="button" onClick={() => setCancelFor(null)} className="btn-secondary text-sm">{t('common.cancel')}</button>
                <button
                  type="button"
                  onClick={confirmCancel}
                  disabled={!cancelReasonKey || previewing || cancelling}
                  className="btn-danger text-sm"
                >
                  {cancelling ? t('common.loading') : t('active.cancelJob')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
