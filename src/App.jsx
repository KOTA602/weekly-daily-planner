import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const EVENT_STORAGE_KEY = 'wdp_events_v1'
const TASK_STORAGE_KEY = 'wdp_tasks_v1'
const MEMO_STORAGE_KEY = 'wdp_memos_v1'
const REMINDER_FIRED_STORAGE_KEY = 'wdp_reminders_fired_v1'
const GOOGLE_CONNECTED_STORAGE_KEY = 'wdp_google_connected_v1'
const UNDATED_TASK_DATE = '__undated__'
const SHARED_MEMO_KEY = '__shared_memo__'
const GOOGLE_EVENT_SOURCE = 'google-calendar'
const GOOGLE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const GOOGLE_SCOPES = GOOGLE_EVENTS_SCOPE
const GOOGLE_TIME_ZONE = 'Asia/Tokyo'
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const GOOGLE_CONFIG = {
  clientId: import.meta.env.VITE_GOOGLE_CLIENT_ID || '',
  apiKey: import.meta.env.VITE_GOOGLE_API_KEY || ''
}
const MIN_WEEK = startOfWeek(new Date('2026-01-01'))
const MAX_WEEK = startOfWeek(new Date('2030-12-31'))

function startOfWeek(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = (day + 6) % 7 // Monday=0
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function formatISO(d) {
  const dt = new Date(d)
  const y = dt.getFullYear()
  const m = String(dt.getMonth() + 1).padStart(2, '0')
  const day = String(dt.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function minutesFromTime(t) {
  const [hh, mm] = t.split(':').map(Number)
  return hh * 60 + (mm || 0)
}

function minutesToTime(minutes) {
  const clamped = Math.max(0, Math.min(1440, minutes))
  const hh = Math.floor(clamped / 60)
  const mm = clamped % 60
  return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

const HOURS = Array.from({ length: 20 }, (_, i) => 5 + i) // 5..24
const TIME_LABELS = HOURS.map(hour => {
  if (hour === 24) return '24:00'
  return `${String(hour).padStart(2, '0')}:00`
})
const ROW_HEIGHT = 23 // px per hour
const STEP_MINUTES = 10
const STEPS_PER_HOUR = 60 / STEP_MINUTES
const GRID_START_MINUTES = 5 * 60
const GRID_END_MINUTES = 24 * 60
const TIME_OPTIONS = Array.from(
  { length: (GRID_END_MINUTES - GRID_START_MINUTES) / STEP_MINUTES + 1 },
  (_, i) => minutesToTime(GRID_START_MINUTES + i * STEP_MINUTES)
)
const DEFAULT_EVENT_REMINDER_OFFSETS = [30, 10, 5]
const EVENT_REMINDER_CHOICES = [
  { value: 60, label: '1時間前' },
  { value: 30, label: '30分前' },
  { value: 10, label: '10分前' },
  { value: 5, label: '5分前' }
]
const REMINDER_GRACE_MS = 90 * 1000
const GOOGLE_AUTO_SYNC_INTERVAL_MS = 60 * 1000

function snapToStep(minutes) {
  return Math.round(minutes / STEP_MINUTES) * STEP_MINUTES
}

function clampGridMinutes(minutes, min = GRID_START_MINUTES, max = GRID_END_MINUTES) {
  return clamp(snapToStep(minutes), min, max)
}

function gridTopFromMinutes(minutes) {
  return ((minutes - GRID_START_MINUTES) / 60) * ROW_HEIGHT
}

function gridHeightFromMinutes(startMinutes, endMinutes) {
  return ((endMinutes - startMinutes) / 60) * ROW_HEIGHT
}

function minutesFromPointer(e, element) {
  const rect = element.getBoundingClientRect()
  const y = e.clientY - rect.top + element.scrollTop
  const minutesFromStart = (y / ROW_HEIGHT) * 60
  return clampGridMinutes(GRID_START_MINUTES + minutesFromStart)
}

function eventRangeFromSelection(anchorMinutes, currentMinutes) {
  let startMinutes = Math.min(anchorMinutes, currentMinutes)
  let endMinutes = Math.max(anchorMinutes, currentMinutes)

  if (startMinutes === endMinutes) {
    if (startMinutes >= GRID_END_MINUTES) {
      startMinutes = GRID_END_MINUTES - STEP_MINUTES
    }
    endMinutes = startMinutes + STEP_MINUTES
  }

  startMinutes = clampGridMinutes(startMinutes, GRID_START_MINUTES, GRID_END_MINUTES - STEP_MINUTES)
  endMinutes = clampGridMinutes(endMinutes, startMinutes + STEP_MINUTES, GRID_END_MINUTES)

  return { startMinutes, endMinutes }
}

function normalizeEventTimeRange(startTime, endTime) {
  const startMinutes = clampGridMinutes(
    minutesFromTime(startTime),
    GRID_START_MINUTES,
    GRID_END_MINUTES - STEP_MINUTES
  )
  const endMinutes = clampGridMinutes(
    minutesFromTime(endTime),
    startMinutes + STEP_MINUTES,
    GRID_END_MINUTES
  )

  return {
    startTime: minutesToTime(startMinutes),
    endTime: minutesToTime(endMinutes)
  }
}

function normalizePlannerEvent(event) {
  return {
    ...event,
    ...normalizeEventTimeRange(event.startTime || '05:00', event.endTime || '06:00')
  }
}

function googleDateTime(dateISO, time) {
  const [year, month, day] = dateISO.split('-').map(Number)
  let [hour, minute] = time.split(':').map(Number)
  const dayOffset = hour === 24 ? 1 : 0

  if (hour === 24) {
    hour = 0
    minute = 0
  }

  const date = new Date(Date.UTC(year, month - 1, day + dayOffset))
  const datePart = [
    date.getUTCFullYear(),
    String(date.getUTCMonth() + 1).padStart(2, '0'),
    String(date.getUTCDate()).padStart(2, '0')
  ].join('-')

  return `${datePart}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+09:00`
}

function googleDateTimeParts(dateTime) {
  const date = new Date(dateTime)
  if (Number.isNaN(date.getTime())) return null

  const formatter = new Intl.DateTimeFormat('ja-JP', {
    timeZone: GOOGLE_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23'
  })
  const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]))

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`
  }
}

function eventToGoogleCalendarPayload(event) {
  const normalizedTimes = normalizeEventTimeRange(event.startTime, event.endTime)

  return {
    summary: event.title,
    start: {
      dateTime: googleDateTime(event.date, normalizedTimes.startTime),
      timeZone: GOOGLE_TIME_ZONE
    },
    end: {
      dateTime: googleDateTime(event.date, normalizedTimes.endTime),
      timeZone: GOOGLE_TIME_ZONE
    },
    reminders: {
      useDefault: true
    }
  }
}

function hasGoogleEventsScope(tokenResponse) {
  if (!tokenResponse || !window.google?.accounts?.oauth2) return false
  return window.google.accounts.oauth2.hasGrantedAllScopes(tokenResponse, GOOGLE_EVENTS_SCOPE)
}

async function readGoogleCalendarResponse(response) {
  if (response.status === 204) return null

  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function googleCalendarApiError(response, responseBody, fallbackMessage) {
  const error = new Error(responseBody?.error?.message || fallbackMessage)
  error.status = response.status
  error.response = responseBody
  return error
}

async function insertGoogleCalendarEvent(event, accessToken) {
  const normalizedEvent = normalizePlannerEvent(event)
  const googleEventBody = eventToGoogleCalendarPayload(normalizedEvent)
  console.log('creating google event', normalizedEvent)
  console.log('sending event to Google Calendar', googleEventBody)

  const response = await fetch(GOOGLE_EVENTS_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(googleEventBody)
  })
  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google Calendar insert response', responseBody)
  console.log('Google events.insert response', responseBody)

  if (!response.ok) {
    throw googleCalendarApiError(response, responseBody, 'Google Calendar insert failed')
  }

  return responseBody
}

async function listGoogleCalendarEvents({ timeMin, timeMax }, accessToken) {
  const params = new URLSearchParams({
    timeMin,
    timeMax,
    timeZone: GOOGLE_TIME_ZONE,
    showDeleted: 'false',
    singleEvents: 'true',
    maxResults: '250',
    orderBy: 'startTime'
  })
  console.log('loading google events', { timeMin, timeMax })

  const response = await fetch(`${GOOGLE_EVENTS_URL}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.list response', responseBody)

  if (!response.ok) {
    throw googleCalendarApiError(response, responseBody, 'Google Calendar list failed')
  }

  return responseBody || {}
}

async function updateGoogleCalendarEvent(event, accessToken) {
  const googleEventId = event.googleEventId
  console.log('updating google event', googleEventId)

  const response = await fetch(`${GOOGLE_EVENTS_URL}/${encodeURIComponent(googleEventId)}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(eventToGoogleCalendarPayload(event))
  })
  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.patch response', responseBody)

  if (!response.ok) {
    throw googleCalendarApiError(response, responseBody, 'Google Calendar update failed')
  }

  return responseBody
}

async function deleteGoogleCalendarEvent(googleEventId, accessToken) {
  console.log('deleting google event', googleEventId)

  const response = await fetch(`${GOOGLE_EVENTS_URL}/${encodeURIComponent(googleEventId)}`, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  })
  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.delete response', {
    ok: response.ok,
    status: response.status,
    body: responseBody
  })

  if (!response.ok) {
    throw googleCalendarApiError(response, responseBody, 'Google Calendar delete failed')
  }

  return responseBody
}

function loadScript(src, id) {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(id)
    if (existing?.dataset.loaded === 'true') {
      resolve()
      return
    }
    if (existing) {
      existing.addEventListener('load', () => resolve(), { once: true })
      existing.addEventListener('error', () => reject(new Error(`${src} を読み込めませんでした`)), { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = id
    script.src = src
    script.async = true
    script.defer = true
    script.onload = () => {
      script.dataset.loaded = 'true'
      resolve()
    }
    script.onerror = () => reject(new Error(`${src} を読み込めませんでした`))
    document.head.appendChild(script)
  })
}

function normalizeGoogleEvent(item) {
  const googleEventId = item.id || item.etag
  const summary = item.summary || '無題の予定'
  const isAllDay = Boolean(item.start?.date)

  if (!googleEventId || isAllDay) return null

  const start = item.start?.dateTime ? googleDateTimeParts(item.start.dateTime) : null
  const end = item.end?.dateTime ? googleDateTimeParts(item.end.dateTime) : null
  if (!start || !end) return null

  let endTime = end.time
  if (end.date !== start.date) {
    endTime = '24:00'
  }

  const normalizedTimes = normalizeEventTimeRange(start.time, endTime)

  return {
    id: `${GOOGLE_EVENT_SOURCE}-${googleEventId}`,
    googleEventId,
    source: GOOGLE_EVENT_SOURCE,
    htmlLink: item.htmlLink || '',
    title: summary,
    date: start.date,
    startTime: normalizedTimes.startTime,
    endTime: normalizedTimes.endTime
  }
}

function eventSyncSignature(event) {
  const normalizedTimes = normalizeEventTimeRange(event.startTime, event.endTime)

  return [
    event.title?.trim() || '',
    event.date,
    normalizedTimes.startTime,
    normalizedTimes.endTime
  ].join('|')
}

function mergeGoogleImportedEvents(localEvents, importedEvents, weekDateSet) {
  const importedByGoogleId = new Map()
  const importedBySignature = new Map()
  importedEvents.forEach(event => {
    if (event.googleEventId) {
      importedByGoogleId.set(event.googleEventId, event)
    }
    importedBySignature.set(eventSyncSignature(event), event)
  })

  const consumedGoogleIds = new Set()
  const mergedEvents = []

  localEvents.forEach(event => {
    const imported = event.googleEventId ? importedByGoogleId.get(event.googleEventId) : null
    const matchingImported = event.googleEventId ? null : importedBySignature.get(eventSyncSignature(event))
    const matchedImported = imported || matchingImported

    if (matchedImported) {
      if (consumedGoogleIds.has(matchedImported.googleEventId)) return

      consumedGoogleIds.add(matchedImported.googleEventId)
      mergedEvents.push({
        ...event,
        ...matchedImported,
        id: event.id,
        source: event.source,
        googleHtmlLink: matchedImported.htmlLink || event.googleHtmlLink || ''
      })
      return
    }

    if (event.source === GOOGLE_EVENT_SOURCE && weekDateSet.has(event.date)) {
      return
    }

    mergedEvents.push(event)
  })

  importedEvents.forEach(event => {
    if (!event.googleEventId || consumedGoogleIds.has(event.googleEventId)) return

    consumedGoogleIds.add(event.googleEventId)
    mergedEvents.push(event)
  })

  return mergedEvents
}

function createLocalId(prefix) {
  return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1000)}`
}

function dateAtMinutes(dateISO, minutes) {
  const date = new Date(`${dateISO}T00:00`)
  date.setMinutes(minutes)
  return date
}

function sortReminderOffsets(offsets) {
  return [...new Set(offsets)]
    .map(Number)
    .filter(offset => EVENT_REMINDER_CHOICES.some(choice => choice.value === offset))
    .sort((a, b) => b - a)
}

function reminderOffsetLabel(offset) {
  const choice = EVENT_REMINDER_CHOICES.find(item => item.value === offset)
  return choice ? choice.label : `${offset}分前`
}

function reminderOffsetsForEvent(event) {
  if (Array.isArray(event.reminderOffsets)) {
    return sortReminderOffsets(event.reminderOffsets)
  }

  if (event.reminderOffset !== undefined && event.reminderOffset !== null) {
    if (event.reminderOffset === '') return []
    return sortReminderOffsets([event.reminderOffset])
  }

  return DEFAULT_EVENT_REMINDER_OFFSETS
}

function eventReminderDueItems(event, nowDate) {
  const start = dateAtMinutes(event.date, minutesFromTime(event.startTime))
  const nowMs = nowDate.getTime()
  const offsets = reminderOffsetsForEvent(event)

  return offsets.map(offset => {
    const dueAt = new Date(start.getTime() - offset * 60 * 1000)
    const elapsed = nowMs - dueAt.getTime()

    if (elapsed < 0 || elapsed > REMINDER_GRACE_MS) return null

    return {
      key: `event:${event.id}:${offset}:${dueAt.toISOString()}`,
      title: event.title,
      body: `${event.startTime}からの予定です（${reminderOffsetLabel(offset)}）`,
      dueAt
    }
  }).filter(Boolean)
}

function dayHeaderTone(date) {
  const day = new Date(date).getDay()
  if (day === 6) return 'saturday'
  if (day === 0) return 'sunday'
  return ''
}

function defaultEvents() {
  try {
    const raw = localStorage.getItem(EVENT_STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.map(normalizePlannerEvent) : []
  } catch {
    return []
  }
}

function defaultTasks() {
  try {
    const raw = localStorage.getItem(TASK_STORAGE_KEY)
    return raw ? JSON.parse(raw) : []
  } catch {
    return []
  }
}

function defaultMemos() {
  try {
    const raw = localStorage.getItem(MEMO_STORAGE_KEY)
    if (!raw) return {}

    const parsed = JSON.parse(raw)
    if (parsed[SHARED_MEMO_KEY] !== undefined) return parsed

    const thisWeekKey = formatISO(startOfWeek(new Date()))
    const fallbackMemo = parsed[thisWeekKey] || Object.values(parsed).find(value => (
      typeof value === 'string' && value.trim()
    )) || ''

    return { ...parsed, [SHARED_MEMO_KEY]: fallbackMemo }
  } catch {
    return {}
  }
}

function defaultFiredReminders() {
  try {
    const raw = localStorage.getItem(REMINDER_FIRED_STORAGE_KEY)
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function defaultGoogleConnected() {
  try {
    return localStorage.getItem(GOOGLE_CONNECTED_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

function saveEvents(events) {
  localStorage.setItem(EVENT_STORAGE_KEY, JSON.stringify(events))
}

function saveTasks(tasks) {
  localStorage.setItem(TASK_STORAGE_KEY, JSON.stringify(tasks))
}

function saveMemos(memos) {
  localStorage.setItem(MEMO_STORAGE_KEY, JSON.stringify(memos))
}

function saveFiredReminders(reminders) {
  localStorage.setItem(REMINDER_FIRED_STORAGE_KEY, JSON.stringify(reminders))
}

function saveGoogleConnected(connected) {
  localStorage.setItem(GOOGLE_CONNECTED_STORAGE_KEY, connected ? 'true' : 'false')
}

function formatClock(date) {
  return date.toLocaleTimeString('ja-JP', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  })
}

function EventForm({ initial, onSave, onDelete, onCancel }) {
  const initialTimes = normalizeEventTimeRange(initial.startTime || '05:00', initial.endTime || '06:00')
  const [title, setTitle] = useState(initial.title ?? '')
  const [date, setDate] = useState(initial.date || formatISO(new Date()))
  const [startTime, setStartTime] = useState(initialTimes.startTime)
  const [endTime, setEndTime] = useState(initialTimes.endTime)
  const [reminderOffsets, setReminderOffsets] = useState(() => reminderOffsetsForEvent(initial))

  function submit(e) {
    e && e.preventDefault()
    if (!title.trim()) return
    const eventData = { ...initial }
    delete eventData.reminderOffset
    const normalizedTimes = normalizeEventTimeRange(startTime, endTime)

    onSave({
      ...eventData,
      title,
      date,
      ...normalizedTimes,
      reminderOffsets
    })
  }

  function toggleReminderOffset(offset) {
    setReminderOffsets(prev => {
      if (prev.includes(offset)) {
        return prev.filter(item => item !== offset)
      }
      return sortReminderOffsets([...prev, offset])
    })
  }

  return (
    <div className="event-form-backdrop">
      <form className="event-form" onSubmit={submit}>
        <h3>{initial.id ? '予定を編集' : '予定を追加'}</h3>
        <label>
          タイトル
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            autoFocus
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
          />
        </label>
        <label>
          日付
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </label>
        <div className="time-row">
          <label>
            開始
            <select value={startTime} onChange={e => setStartTime(e.target.value)}>
              {TIME_OPTIONS.map(slot => (
                <option key={slot} value={slot}>{slot}</option>
              ))}
            </select>
          </label>
          <label>
            終了
            <select value={endTime} onChange={e => setEndTime(e.target.value)}>
              {TIME_OPTIONS.map(slot => (
                <option key={slot} value={slot}>{slot}</option>
              ))}
            </select>
          </label>
        </div>
        <fieldset className="event-reminder-field">
          <legend>リマインダー</legend>
          <div className="event-reminder-options">
            <button
              type="button"
              className={`reminder-option none ${reminderOffsets.length === 0 ? 'active' : ''}`}
              onClick={() => setReminderOffsets([])}
            >
              通知なし
            </button>
            {EVENT_REMINDER_CHOICES.map(option => (
              <label
                key={option.value}
                className={`reminder-option ${reminderOffsets.includes(option.value) ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={reminderOffsets.includes(option.value)}
                  onChange={() => toggleReminderOffset(option.value)}
                />
                {option.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>キャンセル</button>
          {initial.id && (
            <button type="button" className="btn danger" onClick={() => onDelete(initial.id)}>
              削除
            </button>
          )}
          <button type="submit" className="btn primary">保存</button>
        </div>
      </form>
    </div>
  )
}

export default function App() {
  const googleConfigured = Boolean(GOOGLE_CONFIG.clientId)
  const googleTokenClient = useRef(null)
  const googleAccessTokenRef = useRef('')
  const googleConnectedRef = useRef(false)
  const eventsRef = useRef([])
  const dragUpdatedEventRef = useRef(null)
  const pendingGoogleInsertIdsRef = useRef(new Set())
  const updateGoogleEventRef = useRef(null)
  const syncCurrentWeekWithGoogleRef = useRef(null)
  const isSyncingRef = useRef(false)
  const [centerDate, setCenterDate] = useState(() => {
    const today = startOfWeek(new Date())
    if (today < MIN_WEEK) return MIN_WEEK
    if (today > MAX_WEEK) return MAX_WEEK
    return today
  })
  const [events, setEvents] = useState(() => defaultEvents())
  const [tasks, setTasks] = useState(() => defaultTasks())
  const [memos, setMemos] = useState(() => defaultMemos())
  const [editing, setEditing] = useState(null)
  const [dragSelection, setDragSelection] = useState(null)
  const [dragState, setDragState] = useState(null)
  const [draggedTaskId, setDraggedTaskId] = useState(null)
  const dragSelectionBodyRef = useRef(null)
  const dragSelectionRef = useRef(null)
  const [now, setNow] = useState(new Date())
  const [taskDrafts, setTaskDrafts] = useState({})
  const [firedReminders, setFiredReminders] = useState(() => defaultFiredReminders())
  const [activeReminders, setActiveReminders] = useState([])
  const [notificationPermission, setNotificationPermission] = useState(() => (
    'Notification' in window ? window.Notification.permission : 'unsupported'
  ))
  const [googleReady, setGoogleReady] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(() => defaultGoogleConnected())
  const [googleStatus, setGoogleStatus] = useState(googleConfigured ? 'idle' : 'missing-config')
  const [googleMessage, setGoogleMessage] = useState(googleConfigured ? 'Google準備OK' : 'Google設定待ち')
  const [isSyncing, setIsSyncing] = useState(false)

  useEffect(() => saveEvents(events), [events])
  useEffect(() => saveTasks(tasks), [tasks])
  useEffect(() => saveMemos(memos), [memos])
  useEffect(() => saveFiredReminders(firedReminders), [firedReminders])
  useEffect(() => saveGoogleConnected(googleConnected), [googleConnected])

  const weekDates = useMemo(() => {
    const base = new Date(centerDate)
    return Array.from({ length: 7 }).map((_, i) => {
      const d = new Date(base)
      d.setDate(base.getDate() + i)
      return d
    })
  }, [centerDate])

  const memoText = memos[SHARED_MEMO_KEY] || ''
  const canPrevWeek = centerDate.getTime() > MIN_WEEK.getTime()
  const canNextWeek = centerDate.getTime() < MAX_WEEK.getTime()
  const weekLabel = `${weekDates[0].getFullYear()}年${weekDates[0].getMonth() + 1}月${weekDates[0].getDate()}日〜${weekDates[6].getMonth() + 1}月${weekDates[6].getDate()}日`
  const currentDateISO = formatISO(now)
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const currentTimeTop = ((currentMinutes - GRID_START_MINUTES) / 60) * ROW_HEIGHT
  const currentTimeVisible = currentMinutes >= GRID_START_MINUTES && currentMinutes <= GRID_END_MINUTES

  useEffect(() => {
    dragSelectionRef.current = dragSelection
  }, [dragSelection])

  useEffect(() => {
    googleConnectedRef.current = googleConnected
  }, [googleConnected])

  useEffect(() => {
    eventsRef.current = events
  }, [events])

  useEffect(() => {
    if (!dragSelection) return
    function handlePointerMove(e) {
      const dayBody = dragSelectionBodyRef.current
      if (!dayBody) return
      e.preventDefault()
      const nextMinutes = minutesFromPointer(e, dayBody)
      setDragSelection(prev => {
        if (!prev) return prev
        const next = { ...prev, currentMinutes: nextMinutes }
        dragSelectionRef.current = next
        return next
      })
    }

    function handlePointerUp(e) {
      const dayBody = dragSelectionBodyRef.current
      const activeSelection = dragSelectionRef.current || dragSelection
      if (!activeSelection) return
      const finalSelection = dayBody
        ? { ...activeSelection, currentMinutes: minutesFromPointer(e, dayBody) }
        : activeSelection
      const { startMinutes, endMinutes } = eventRangeFromSelection(
        finalSelection.anchorMinutes,
        finalSelection.currentMinutes
      )
      setEditing({
        id: null,
        date: finalSelection.date,
        startTime: minutesToTime(startMinutes),
        endTime: minutesToTime(endMinutes),
        title: ''
      })
      setDragSelection(null)
      dragSelectionBodyRef.current = null
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [dragSelection])

  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 60000)
    return () => clearInterval(interval)
  }, [])

  useEffect(() => {
    const reminders = []

    events.forEach(event => {
      reminders.push(...eventReminderDueItems(event, now))
    })

    const freshReminders = reminders.filter(reminder => !firedReminders[reminder.key])
    if (!freshReminders.length) return

    const timer = window.setTimeout(() => {
      setFiredReminders(prev => {
        const next = { ...prev }
        freshReminders.forEach(reminder => {
          next[reminder.key] = true
        })
        return next
      })

      setActiveReminders(prev => [
        ...prev,
        ...freshReminders.filter(reminder => !prev.some(item => item.key === reminder.key))
      ])

      if ('Notification' in window && window.Notification.permission === 'granted') {
        freshReminders.forEach(reminder => {
          new window.Notification('リマインダー', {
            body: `${reminder.title} - ${reminder.body}`
          })
        })
      }
    }, 0)

    return () => window.clearTimeout(timer)
  }, [events, firedReminders, now])

  useEffect(() => {
    if (!dragState) return

    function handlePointerMove(e) {
      e.preventDefault()
      setEvents(prev => prev.map(ev => {
        if (ev.id !== dragState.eventId) return ev

        const deltaY = e.clientY - dragState.originY
        const stepPixels = ROW_HEIGHT / STEPS_PER_HOUR
        const deltaSteps = Math.round(deltaY / stepPixels)
        const deltaMinutes = deltaSteps * STEP_MINUTES
        let newStart = dragState.initialStart
        let newEnd = dragState.initialEnd

        if (dragState.type === 'move') {
          const duration = dragState.initialEnd - dragState.initialStart
          newStart = clamp(dragState.initialStart + deltaMinutes, GRID_START_MINUTES, GRID_END_MINUTES - duration)
          newEnd = newStart + duration
        } else if (dragState.type === 'resize-start') {
          newStart = clamp(dragState.initialStart + deltaMinutes, GRID_START_MINUTES, dragState.initialEnd - STEP_MINUTES)
        } else if (dragState.type === 'resize-end') {
          newEnd = clamp(dragState.initialEnd + deltaMinutes, dragState.initialStart + STEP_MINUTES, GRID_END_MINUTES)
        }

        dragUpdatedEventRef.current = {
          ...ev,
          startTime: minutesToTime(newStart),
          endTime: minutesToTime(newEnd)
        }
        return dragUpdatedEventRef.current
      }))
    }

    function handlePointerUp() {
      const updatedEvent = dragUpdatedEventRef.current || eventsRef.current.find(item => item.id === dragState.eventId)
      if (updatedEvent?.googleEventId) {
        void updateGoogleEventRef.current?.(updatedEvent)
      }
      dragUpdatedEventRef.current = null
      setDragState(null)
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
  }, [dragState])

  function changeWeek(offset) {
    const next = new Date(centerDate)
    next.setDate(next.getDate() + offset)
    const nextWeek = startOfWeek(next)
    if (nextWeek < MIN_WEEK || nextWeek > MAX_WEEK) return
    setCenterDate(nextWeek)
  }

  function saveEvent(ev) {
    const normalizedEvent = {
      ...ev,
      ...normalizeEventTimeRange(ev.startTime, ev.endTime)
    }
    const isNewEvent = !ev.id

    if (!isNewEvent) {
      setEvents(prev => prev.map(item => (item.id === ev.id ? normalizedEvent : item)))
      if (normalizedEvent.googleEventId) {
        void updateEventInGoogleCalendar(normalizedEvent)
      }
    } else {
      const id = createLocalId('event')
      const localEvent = { ...normalizedEvent, id }
      const token = window.gapi?.client?.getToken()
      const accessToken = currentGoogleAccessToken()
      const isGoogleConnected = googleConnectedRef.current || hasGoogleEventsScope(token)

      console.log('planner event created', localEvent)
      console.log('google connected', isGoogleConnected)
      console.log('access token exists', Boolean(accessToken))

      setEvents(prev => [...prev, localEvent])

      if (isGoogleConnected) {
        void addEventToGoogleCalendar(localEvent)
      }
    }
    setEditing(null)
  }

  function deleteEvent(id) {
    const event = eventsRef.current.find(item => item.id === id)
    setEvents(prev => prev.filter(item => item.id !== id))
    setEditing(null)

    if (event?.googleEventId) {
      void deleteEventFromGoogleCalendar(event)
    }
  }

  function openEdit(ev) {
    setEditing(ev)
  }

  function currentGoogleAccessToken() {
    return googleAccessTokenRef.current || window.gapi?.client?.getToken()?.access_token || ''
  }

  async function ensureGoogleAccessToken(options = {}) {
    let token = window.gapi?.client?.getToken()
    if (!hasGoogleEventsScope(token) || !currentGoogleAccessToken()) {
      await requestGoogleAccess(options)
      token = window.gapi?.client?.getToken()
    }

    const accessToken = currentGoogleAccessToken()
    const isGoogleConnected = googleConnectedRef.current || hasGoogleEventsScope(token)
    console.log('google connected', isGoogleConnected)
    console.log('access token exists', Boolean(accessToken))

    if (!accessToken) {
      throw new Error('Googleアクセストークンがありません')
    }

    return accessToken
  }

  async function initializeGoogleCalendar(options = {}) {
    if (!googleConfigured) {
      throw new Error('Googleの認証情報が設定されていません')
    }

    if (googleReady && googleTokenClient.current) return googleTokenClient.current

    if (!options.silent) {
      setGoogleStatus('loading')
      setGoogleMessage('Google読込中')
    }

    await Promise.all([
      loadScript('https://apis.google.com/js/api.js', 'google-api-client'),
      loadScript('https://accounts.google.com/gsi/client', 'google-identity-services')
    ])

    await new Promise((resolve, reject) => {
      window.gapi.load('client', { callback: resolve, onerror: reject })
    })

    await window.gapi.client.init({
      ...(GOOGLE_CONFIG.apiKey ? { apiKey: GOOGLE_CONFIG.apiKey } : {}),
      discoveryDocs: [GOOGLE_DISCOVERY_DOC]
    })

    googleTokenClient.current = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CONFIG.clientId,
      scope: GOOGLE_SCOPES,
      include_granted_scopes: true,
      callback: () => {}
    })

    setGoogleReady(true)
    if (!options.silent) {
      setGoogleStatus('ready')
      setGoogleMessage('Google準備OK')
    }
    return googleTokenClient.current
  }

  async function requestGoogleAccess(options = {}) {
    const tokenClient = await initializeGoogleCalendar({ silent: options.silent })

    return new Promise((resolve, reject) => {
      tokenClient.callback = response => {
        if (response.error) {
          console.log('Google Identity Services token error', response)
          reject(new Error(response.error))
          return
        }

        if (!hasGoogleEventsScope(response)) {
          console.log('Google Identity Services token missing calendar.events scope', response)
          reject(new Error('Googleカレンダーの追加権限が許可されていません'))
          return
        }

        if (response.access_token) {
          googleAccessTokenRef.current = response.access_token
          window.gapi?.client?.setToken(response)
        }

        console.log('Google Identity Services token granted calendar.events scope', {
          scope: response.scope
        })
        googleConnectedRef.current = true
        setGoogleConnected(true)
        setGoogleStatus('connected')
        setGoogleMessage('Google連携済み')
        resolve(response)
      }

      const token = window.gapi.client.getToken()
      const prompt = options.prompt ?? (hasGoogleEventsScope(token) ? '' : 'consent')
      tokenClient.requestAccessToken({ prompt })
    })
  }

  async function connectGoogleCalendar() {
    try {
      setGoogleStatus('loading')
      setGoogleMessage('Google連携中')
      await requestGoogleAccess()
    } catch (error) {
      googleConnectedRef.current = false
      setGoogleConnected(false)
      setGoogleStatus('error')
      setGoogleMessage(error.message || 'Google連携に失敗しました')
    }
  }

  async function addEventToGoogleCalendar(event) {
    if (event.googleEventId) return event
    if (pendingGoogleInsertIdsRef.current.has(event.id)) return event

    pendingGoogleInsertIdsRef.current.add(event.id)
    try {
      setGoogleStatus('adding')
      setGoogleMessage('Googleカレンダーに追加中')

      const normalizedEvent = normalizePlannerEvent(event)
      const accessToken = await ensureGoogleAccessToken()
      const response = await insertGoogleCalendarEvent(normalizedEvent, accessToken)

      console.log('Google Calendar events.insert success', {
        localEventId: event.id,
        googleEventId: response.id,
        result: response
      })

      const syncedEvent = {
        ...normalizedEvent,
        googleEventId: response.id,
        googleHtmlLink: response.htmlLink || ''
      }

      setEvents(prev => prev.map(item => (
        item.id === event.id ? { ...item, ...syncedEvent } : item
      )))
      googleConnectedRef.current = true
      setGoogleConnected(true)
      setGoogleStatus('connected')
      setGoogleMessage('Googleカレンダーに追加しました')
      return syncedEvent
    } catch (error) {
      console.error('Google Calendar insert failed', error)
      console.log('Google Calendar events.insert failed', {
        localEventId: event.id,
        error
      })
      setGoogleStatus('error')
      setGoogleMessage('Googleカレンダーへの追加に失敗しました。Consoleを確認してください。')
      return event
    } finally {
      pendingGoogleInsertIdsRef.current.delete(event.id)
    }
  }

  async function updateEventInGoogleCalendar(event) {
    if (!event.googleEventId || !googleConfigured) return

    try {
      const accessToken = await ensureGoogleAccessToken()
      await updateGoogleCalendarEvent(event, accessToken)
      setGoogleStatus('connected')
    } catch (error) {
      console.error('Google Calendar update failed', error)
      setGoogleStatus('error')
      setGoogleMessage('Googleカレンダーの更新に失敗しました。Consoleを確認してください。')
    }
  }

  useEffect(() => {
    updateGoogleEventRef.current = updateEventInGoogleCalendar
  })

  async function deleteEventFromGoogleCalendar(event) {
    if (!event.googleEventId || !googleConfigured) return

    try {
      const accessToken = await ensureGoogleAccessToken()
      await deleteGoogleCalendarEvent(event.googleEventId, accessToken)
      setGoogleStatus('connected')
    } catch (error) {
      console.error('Google Calendar delete failed', error)
      setGoogleStatus('error')
      setGoogleMessage('Googleカレンダーの削除に失敗しました。Consoleを確認してください。')
    }
  }

  async function syncUnsyncedPlannerEventsToGoogle(localEvents, weekDateSet, accessToken) {
    let syncedCount = 0
    let failureCount = 0
    let nextEvents = localEvents

    for (const event of localEvents) {
      const shouldSync = (
        !event.googleEventId &&
        event.source !== GOOGLE_EVENT_SOURCE &&
        weekDateSet.has(event.date) &&
        !pendingGoogleInsertIdsRef.current.has(event.id)
      )

      if (!shouldSync) continue

      pendingGoogleInsertIdsRef.current.add(event.id)
      try {
        const normalizedEvent = normalizePlannerEvent(event)
        const response = await insertGoogleCalendarEvent(normalizedEvent, accessToken)
        syncedCount += 1
        nextEvents = nextEvents.map(item => (
          item.id === event.id
            ? {
                ...item,
                ...normalizedEvent,
                googleEventId: response.id,
                googleHtmlLink: response.htmlLink || ''
              }
            : item
        ))
      } catch (error) {
        failureCount += 1
        console.error('Google Calendar insert failed', error)
      } finally {
        pendingGoogleInsertIdsRef.current.delete(event.id)
      }
    }

    return { events: nextEvents, syncedCount, failureCount }
  }

  async function syncCurrentWeekWithGoogle(options = {}) {
    const automatic = Boolean(options.automatic)
    if (automatic) console.log('auto sync start')

    if (!googleConfigured) {
      if (automatic) console.log('auto sync skipped: not connected')
      setGoogleStatus('missing-config')
      setGoogleMessage('Google設定待ち')
      return
    }

    const token = window.gapi?.client?.getToken()
    const isGoogleConnected = googleConnectedRef.current || hasGoogleEventsScope(token)

    if (!isGoogleConnected) {
      if (automatic) console.log('auto sync skipped: not connected')
      return
    }

    if (isSyncingRef.current) {
      return
    }

    isSyncingRef.current = true
    setIsSyncing(true)

    try {
      let accessToken = currentGoogleAccessToken()
      if (!accessToken) {
        if (automatic) {
          try {
            await requestGoogleAccess({ prompt: '', silent: true })
          } catch {
            console.log('auto sync skipped: no access token')
            return
          }

          accessToken = currentGoogleAccessToken()
          if (!accessToken) {
            console.log('auto sync skipped: no access token')
            return
          }
        } else {
          accessToken = await ensureGoogleAccessToken()
        }
      }

      setGoogleStatus('syncing')
      setGoogleMessage('同期中...')

      const weekStartISO = formatISO(weekDates[0])
      const weekEndISO = formatISO(weekDates[6])
      const timeMin = googleDateTime(weekStartISO, '00:00')
      const timeMax = googleDateTime(weekEndISO, '24:00')

      console.log('syncing week', { timeMin, timeMax })
      const data = await listGoogleCalendarEvents({ timeMin, timeMax }, accessToken)
      const googleItems = data.items || []
      const weekDateSet = new Set(weekDates.map(day => formatISO(day)))
      const importedEvents = googleItems
        .map(normalizeGoogleEvent)
        .filter(item => item && weekDateSet.has(item.date))

      if (googleItems.length === 0) {
        console.log('Google Calendar API returned 0 events for this week', data)
      }

      const mergedEvents = mergeGoogleImportedEvents(eventsRef.current, importedEvents, weekDateSet)
      const syncResult = await syncUnsyncedPlannerEventsToGoogle(mergedEvents, weekDateSet, accessToken)
      setEvents(syncResult.events)

      console.log('auto sync completed', {
        importedCount: importedEvents.length,
        uploadedCount: syncResult.syncedCount
      })
      setGoogleStatus('connected')
      if (syncResult.failureCount > 0) {
        setGoogleMessage('同期に失敗しました')
      } else {
        setGoogleMessage(`最終同期: ${formatClock(new Date())}`)
      }
    } catch (error) {
      console.error('auto sync failed', error)
      console.error('Google Calendar list failed', error)
      setGoogleStatus('error')
      setGoogleMessage('同期に失敗しました')
    } finally {
      isSyncingRef.current = false
      setIsSyncing(false)
    }
  }

  useEffect(() => {
    syncCurrentWeekWithGoogleRef.current = syncCurrentWeekWithGoogle
  })

  useEffect(() => {
    void syncCurrentWeekWithGoogleRef.current?.({ automatic: true })
  }, [centerDate, googleConnected])

  useEffect(() => {
    const interval = window.setInterval(() => {
      void syncCurrentWeekWithGoogleRef.current?.({ automatic: true })
    }, GOOGLE_AUTO_SYNC_INTERVAL_MS)

    return () => window.clearInterval(interval)
  }, [])

  async function importGoogleWeek() {
    await syncCurrentWeekWithGoogle({ automatic: false })
  }

  function disconnectGoogleCalendar() {
    const token = window.gapi?.client?.getToken()
    if (token) {
      window.google?.accounts?.oauth2?.revoke(token.access_token)
      window.gapi.client.setToken('')
    }
    setGoogleConnected(false)
    googleConnectedRef.current = false
    googleAccessTokenRef.current = ''
    setGoogleStatus(googleReady ? 'ready' : 'idle')
    setGoogleMessage('Google準備OK')
  }

  function startEventDrag(e, ev, type) {
    e.stopPropagation()
    e.preventDefault()
    const dayBody = e.currentTarget.closest('.day-body')
    if (!dayBody) return
    setDragState({
      type,
      eventId: ev.id,
      originY: e.clientY,
      initialStart: minutesFromTime(ev.startTime),
      initialEnd: minutesFromTime(ev.endTime)
    })
  }

  function startCreateDrag(e, dateISO) {
    if (e.button !== 0) return
    if (e.target.closest('.event-block')) return

    e.preventDefault()
    dragSelectionBodyRef.current = e.currentTarget
    const selectedMinutes = minutesFromPointer(e, e.currentTarget)
    const nextSelection = {
      date: dateISO,
      anchorMinutes: selectedMinutes,
      currentMinutes: selectedMinutes
    }
    dragSelectionRef.current = nextSelection
    setDragSelection(nextSelection)
  }

  function eventsFor(dateISO) {
    return events
      .filter(item => item.date === dateISO)
      .map(normalizePlannerEvent)
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  }

  function tasksFor(dateISO) {
    return tasks.filter(item => item.date === dateISO)
  }

  function undatedTasks() {
    return tasks.filter(item => !item.date || item.date === UNDATED_TASK_DATE)
  }

  function updateTaskDraft(dateISO, value) {
    setTaskDrafts(prev => ({ ...prev, [dateISO]: value }))
  }

  function addTask(dateISO) {
    const title = (taskDrafts[dateISO] || '').trim()
    if (!title) return
    const id = createLocalId('task')
    setTasks(prev => [...prev, { id, date: dateISO, title, completed: false }])
    updateTaskDraft(dateISO, '')
  }

  function startTaskDrag(e, taskId) {
    setDraggedTaskId(taskId)
    e.dataTransfer.effectAllowed = 'move'
    e.dataTransfer.setData('text/plain', taskId)
  }

  function allowTaskDrop(e) {
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
  }

  function moveTaskToDate(e, dateISO) {
    e.preventDefault()
    const taskId = e.dataTransfer.getData('text/plain') || draggedTaskId
    if (!taskId) return

    setTasks(prev => prev.map(item => (
      item.id === taskId ? { ...item, date: dateISO } : item
    )))
    setDraggedTaskId(null)
  }

  async function requestNotificationPermission() {
    if (!('Notification' in window)) return
    const permission = await window.Notification.requestPermission()
    setNotificationPermission(permission)
  }

  function dismissReminder(key) {
    setActiveReminders(prev => prev.filter(item => item.key !== key))
  }

  function handleTaskEnter(e, dateISO) {
    if (e.key !== 'Enter') return
    if (e.nativeEvent.isComposing || e.keyCode === 229) return

    e.preventDefault()
    addTask(dateISO)
  }

  function toggleTask(id) {
    setTasks(prev => prev.map(item => item.id === id ? { ...item, completed: !item.completed } : item))
  }

  function deleteTask(id) {
    setTasks(prev => prev.filter(item => item.id !== id))
  }

  function updateMemo(value) {
    setMemos(prev => ({ ...prev, [SHARED_MEMO_KEY]: value }))
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <h1>週間プランナー</h1>
        <div className="header-actions">
          <div className={`google-sync ${googleStatus}`}>
            <span className="google-dot" aria-hidden="true" />
            <span className="google-text">{googleMessage}</span>
            {!googleConnected ? (
              <button
                type="button"
                onClick={connectGoogleCalendar}
                disabled={!googleConfigured || googleStatus === 'loading' || isSyncing}
              >
                Google連携
              </button>
            ) : (
              <button
                type="button"
                onClick={importGoogleWeek}
                disabled={googleStatus === 'loading' || googleStatus === 'syncing' || googleStatus === 'adding' || isSyncing}
              >
                {isSyncing ? '同期中...' : '今週を読込'}
              </button>
            )}
            {googleConnected && (
              <button type="button" className="google-signout" onClick={disconnectGoogleCalendar}>
                連携解除
              </button>
            )}
          </div>
          {'Notification' in window && notificationPermission !== 'granted' && (
            <button type="button" className="notification-button" onClick={requestNotificationPermission}>
              通知許可
            </button>
          )}
        </div>
      </header>

      <main className="planner-grid">
        <aside className="memo-panel">
          <div
            className={`undated-tasks-panel ${draggedTaskId ? 'drop-ready' : ''}`}
            onDragOver={allowTaskDrop}
            onDrop={e => moveTaskToDate(e, UNDATED_TASK_DATE)}
          >
            <div className="tasks-label">無期限タスク</div>
            <div className="tasks-list">
              {undatedTasks().length === 0 && <div className="no-tasks">タスクなし</div>}
              {undatedTasks().map(task => (
                <div
                  key={task.id}
                  className={`task-item ${task.completed ? 'completed' : ''} ${draggedTaskId === task.id ? 'dragging' : ''}`}
                  draggable
                  onDragStart={e => startTaskDrag(e, task.id)}
                  onDragEnd={() => setDraggedTaskId(null)}
                >
                  <label>
                    <input
                      type="checkbox"
                      checked={task.completed}
                      onChange={() => toggleTask(task.id)}
                    />
                    <span className="task-title">{task.title}</span>
                  </label>
                  <button className="task-delete" onClick={() => deleteTask(task.id)}>×</button>
                </div>
              ))}
            </div>
            <div className="task-add">
              <input
                type="text"
                placeholder="タスク入力"
                value={taskDrafts[UNDATED_TASK_DATE] || ''}
                onChange={e => updateTaskDraft(UNDATED_TASK_DATE, e.target.value)}
                onKeyDown={e => handleTaskEnter(e, UNDATED_TASK_DATE)}
              />
              <button type="button" onClick={() => addTask(UNDATED_TASK_DATE)}>＋</button>
            </div>
          </div>
          <div className="week-memo-panel">
            <textarea
              value={memoText}
              onChange={e => updateMemo(e.target.value)}
              placeholder="週メモを書く..."
            />
          </div>
        </aside>

        <section className="schedule-panel weekly">
          <div className="week-controls">
            <button onClick={() => changeWeek(-7)} disabled={!canPrevWeek}>&lt;</button>
            <div className="week-label">{weekLabel}</div>
            <button onClick={() => changeWeek(7)} disabled={!canNextWeek}>&gt;</button>
          </div>

          <div className="timetable weekly">
              <div className="timetable-grid">
                <div className="time-col">
                  <div className="time-header">時間</div>
                  {TIME_LABELS.map(label => (
                    <div key={label} className="time-row" style={{ height: ROW_HEIGHT + 'px' }}>
                      {label}
                    </div>
                  ))}
                </div>

                <div className="days-col">
                  {weekDates.map(day => {
                    const iso = formatISO(day)
                    const dayEvents = eventsFor(iso)
                    const dayTasks = tasksFor(iso)
                    const tone = dayHeaderTone(day)
                    const isDragActive = dragSelection?.date === iso
                    const dragRange = isDragActive
                      ? eventRangeFromSelection(dragSelection.anchorMinutes, dragSelection.currentMinutes)
                      : null
                    return (
                      <div className={`day-column ${tone}`} key={iso}>
                        <div className={`day-header ${tone}`}>
                          <span>{day.toLocaleDateString('ja-JP', { weekday: 'short' })}</span>
                          <strong>{day.getDate()}</strong>
                        </div>
                        <div className="day-body" onPointerDown={e => startCreateDrag(e, iso)}>
                          {HOURS.map(hour => (
                            <div
                              key={hour}
                              className="slot"
                              style={{ height: ROW_HEIGHT + 'px' }}
                            >
                              <span className="slot-hour-label" aria-hidden="true">{hour}</span>
                            </div>
                          ))}
                          {currentTimeVisible && currentDateISO === iso && (
                            <div className="current-time-line" style={{ top: currentTimeTop + 'px' }} />
                          )}
                          {isDragActive && (
                            <div
                              className="drag-selection"
                              style={{
                                top: gridTopFromMinutes(dragRange.startMinutes) + 'px',
                                height: gridHeightFromMinutes(dragRange.startMinutes, dragRange.endMinutes) + 'px'
                              }}
                            />
                          )}

                          {dayEvents.map(ev => {
                            const startMinutes = minutesFromTime(ev.startTime)
                            const endMinutes = minutesFromTime(ev.endTime)
                            const top = gridTopFromMinutes(startMinutes)
                            const height = gridHeightFromMinutes(startMinutes, endMinutes)
                            const visualGap = height >= 8 ? 2 : 0
                            return (
                              <div
                                key={ev.id}
                                className={`event-block ${ev.source === GOOGLE_EVENT_SOURCE ? 'google-event' : ''}`}
                                style={{
                                  top: top + visualGap / 2 + 'px',
                                  height: Math.max(1, height - visualGap) + 'px'
                                }}
                                onClick={e => { e.stopPropagation(); openEdit(ev) }}
                              >
                                <div className="event-handle top" onPointerDown={e => startEventDrag(e, ev, 'resize-start')} />
                                <div className="event-content" onPointerDown={e => startEventDrag(e, ev, 'move')}>
                                  <div className="ev-title">{ev.title}</div>
                                  <div className="ev-time">{ev.startTime} - {ev.endTime}</div>
                                </div>
                                <div className="event-handle bottom" onPointerDown={e => startEventDrag(e, ev, 'resize-end')} />
                              </div>
                            )
                          })}
                        </div>

                        <div
                          className={`tasks-panel ${draggedTaskId ? 'drop-ready' : ''}`}
                          onDragOver={allowTaskDrop}
                          onDrop={e => moveTaskToDate(e, iso)}
                        >
                          <div className="tasks-label">タスク</div>
                          <div className="tasks-list">
                            {dayTasks.length === 0 && <div className="no-tasks">タスクなし</div>}
                            {dayTasks.map(task => (
                              <div
                                key={task.id}
                                className={`task-item ${task.completed ? 'completed' : ''} ${draggedTaskId === task.id ? 'dragging' : ''}`}
                                draggable
                                onDragStart={e => startTaskDrag(e, task.id)}
                                onDragEnd={() => setDraggedTaskId(null)}
                              >
                                <label>
                                  <input
                                    type="checkbox"
                                    checked={task.completed}
                                    onChange={() => toggleTask(task.id)}
                                  />
                                  <span className="task-title">{task.title}</span>
                                </label>
                                <button className="task-delete" onClick={() => deleteTask(task.id)}>×</button>
                              </div>
                            ))}
                          </div>
                          <div className="task-add">
                            <input
                              type="text"
                              placeholder="タスク入力"
                              value={taskDrafts[iso] || ''}
                              onChange={e => updateTaskDraft(iso, e.target.value)}
                              onKeyDown={e => handleTaskEnter(e, iso)}
                            />
                            <button type="button" onClick={() => addTask(iso)}>＋</button>
                          </div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              </div>
            </div>
        </section>
      </main>

      {activeReminders.length > 0 && (
        <div className="reminder-stack">
          {activeReminders.map(reminder => (
            <div className="reminder-toast" key={reminder.key}>
              <div>
                <strong>{reminder.title}</strong>
                <span>{reminder.body}</span>
              </div>
              <button type="button" onClick={() => dismissReminder(reminder.key)}>OK</button>
            </div>
          ))}
        </div>
      )}

      {editing && <EventForm initial={editing} onSave={saveEvent} onDelete={deleteEvent} onCancel={() => setEditing(null)} />}
    </div>
  )
}
