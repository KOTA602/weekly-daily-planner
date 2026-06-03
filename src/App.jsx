import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const EVENT_STORAGE_KEY = 'wdp_events_v1'
const TASK_STORAGE_KEY = 'wdp_tasks_v1'
const MEMO_STORAGE_KEY = 'wdp_memos_v1'
const REMINDER_FIRED_STORAGE_KEY = 'wdp_reminders_fired_v1'
const UNDATED_TASK_DATE = '__undated__'
const SHARED_MEMO_KEY = '__shared_memo__'
const GOOGLE_EVENT_SOURCE = 'google-calendar'
const GOOGLE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
const GOOGLE_SCOPES = 'https://www.googleapis.com/auth/calendar.readonly'
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
const GRID_START_MINUTES = 5 * 60
const GRID_END_MINUTES = 24 * 60
const DEFAULT_EVENT_REMINDER_OFFSETS = [30, 10, 5]
const EVENT_REMINDER_CHOICES = [
  { value: 60, label: '1時間前' },
  { value: 30, label: '30分前' },
  { value: 10, label: '10分前' },
  { value: 5, label: '5分前' }
]
const REMINDER_GRACE_MS = 90 * 1000

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

function minutesFromDate(date) {
  return date.getHours() * 60 + date.getMinutes()
}

function normalizeGoogleEvent(item) {
  const googleEventId = item.id || item.etag
  const summary = item.summary || '無題の予定'
  const isAllDay = Boolean(item.start?.date)

  if (!googleEventId) return null

  if (isAllDay) {
    return {
      id: `${GOOGLE_EVENT_SOURCE}-${googleEventId}`,
      googleEventId,
      source: GOOGLE_EVENT_SOURCE,
      htmlLink: item.htmlLink || '',
      title: `終日: ${summary}`,
      date: item.start.date,
      startTime: '05:00',
      endTime: '06:00'
    }
  }

  const start = item.start?.dateTime ? new Date(item.start.dateTime) : null
  if (!start || Number.isNaN(start.getTime())) return null

  const end = item.end?.dateTime ? new Date(item.end.dateTime) : new Date(start.getTime() + 60 * 60 * 1000)
  const sameDay = end.toDateString() === start.toDateString()
  const startMinutes = clamp(minutesFromDate(start), GRID_START_MINUTES, GRID_END_MINUTES - 5)
  const rawEndMinutes = sameDay ? minutesFromDate(end) : GRID_END_MINUTES
  const endMinutes = clamp(rawEndMinutes, startMinutes + 5, GRID_END_MINUTES)

  return {
    id: `${GOOGLE_EVENT_SOURCE}-${googleEventId}`,
    googleEventId,
    source: GOOGLE_EVENT_SOURCE,
    htmlLink: item.htmlLink || '',
    title: summary,
    date: formatISO(start),
    startTime: minutesToTime(startMinutes),
    endTime: minutesToTime(endMinutes)
  }
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
    return raw ? JSON.parse(raw) : []
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

function EventForm({ initial, onSave, onDelete, onCancel }) {
  const [title, setTitle] = useState(initial.title ?? '')
  const [date, setDate] = useState(initial.date || formatISO(new Date()))
  const [startTime, setStartTime] = useState(initial.startTime || '05:00')
  const [endTime, setEndTime] = useState(initial.endTime || '06:00')
  const [reminderOffsets, setReminderOffsets] = useState(() => reminderOffsetsForEvent(initial))

  // Generate 5-minute interval time slots from 05:00 to 24:00
  const timeSlots = []
  for (let hour = 5; hour < 24; hour++) {
    for (let min = 0; min < 60; min += 5) {
      timeSlots.push(`${String(hour).padStart(2, '0')}:${String(min).padStart(2, '0')}`)
    }
  }
  // Add 24:00 as the final slot
  timeSlots.push('24:00')

  function submit(e) {
    e && e.preventDefault()
    if (!title.trim()) return
    const eventData = { ...initial }
    delete eventData.reminderOffset

    onSave({
      ...eventData,
      title,
      date,
      startTime,
      endTime,
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
              {timeSlots.map(slot => (
                <option key={slot} value={slot}>{slot}</option>
              ))}
            </select>
          </label>
          <label>
            終了
            <select value={endTime} onChange={e => setEndTime(e.target.value)}>
              {timeSlots.map(slot => (
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
  const googleConfigured = Boolean(GOOGLE_CONFIG.clientId && GOOGLE_CONFIG.apiKey)
  const googleTokenClient = useRef(null)
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
  const [now, setNow] = useState(new Date())
  const [taskDrafts, setTaskDrafts] = useState({})
  const [firedReminders, setFiredReminders] = useState(() => defaultFiredReminders())
  const [activeReminders, setActiveReminders] = useState([])
  const [notificationPermission, setNotificationPermission] = useState(() => (
    'Notification' in window ? window.Notification.permission : 'unsupported'
  ))
  const [googleReady, setGoogleReady] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(false)
  const [googleStatus, setGoogleStatus] = useState(googleConfigured ? 'idle' : 'missing-config')
  const [googleMessage, setGoogleMessage] = useState(googleConfigured ? 'Google準備OK' : 'Google設定待ち')

  useEffect(() => saveEvents(events), [events])
  useEffect(() => saveTasks(tasks), [tasks])
  useEffect(() => saveMemos(memos), [memos])
  useEffect(() => saveFiredReminders(firedReminders), [firedReminders])

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
    if (!dragSelection) return
    function handleMouseUp() {
      if (!dragSelection) return
      const startHour = Math.min(dragSelection.anchorHour, dragSelection.currentHour)
      const endHour = Math.min(24, Math.max(dragSelection.anchorHour, dragSelection.currentHour) + 1)
      const startTimeStr = startHour === 24 ? '24:00' : `${String(startHour).padStart(2, '0')}:00`
      const endTimeStr = endHour === 24 ? '24:00' : `${String(endHour).padStart(2, '0')}:00`
      setEditing({
        id: null,
        date: dragSelection.date,
        startTime: startTimeStr,
        endTime: endTimeStr,
        title: ''
      })
      setDragSelection(null)
    }
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
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
        const stepPixels = ROW_HEIGHT / 12
        const deltaSteps = Math.round(deltaY / stepPixels)
        const deltaMinutes = deltaSteps * 5
        let newStart = dragState.initialStart
        let newEnd = dragState.initialEnd

        if (dragState.type === 'move') {
          const duration = dragState.initialEnd - dragState.initialStart
          newStart = clamp(dragState.initialStart + deltaMinutes, GRID_START_MINUTES, GRID_END_MINUTES - duration)
          newEnd = newStart + duration
        } else if (dragState.type === 'resize-start') {
          newStart = clamp(dragState.initialStart + deltaMinutes, GRID_START_MINUTES, dragState.initialEnd - 5)
        } else if (dragState.type === 'resize-end') {
          newEnd = clamp(dragState.initialEnd + deltaMinutes, dragState.initialStart + 5, GRID_END_MINUTES)
        }

        return {
          ...ev,
          startTime: minutesToTime(newStart),
          endTime: minutesToTime(newEnd)
        }
      }))
    }

    function handlePointerUp() {
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
    if (ev.id) {
      setEvents(prev => prev.map(item => (item.id === ev.id ? ev : item)))
    } else {
      const id = createLocalId('event')
      setEvents(prev => [...prev, { ...ev, id }])
    }
    setEditing(null)
  }

  function deleteEvent(id) {
    setEvents(prev => prev.filter(item => item.id !== id))
    setEditing(null)
  }

  function openEdit(ev) {
    setEditing(ev)
  }

  async function initializeGoogleCalendar() {
    if (!googleConfigured) {
      throw new Error('Googleの認証情報が設定されていません')
    }

    if (googleReady && googleTokenClient.current) return googleTokenClient.current

    setGoogleStatus('loading')
    setGoogleMessage('Google読込中')

    await Promise.all([
      loadScript('https://apis.google.com/js/api.js', 'google-api-client'),
      loadScript('https://accounts.google.com/gsi/client', 'google-identity-services')
    ])

    await new Promise((resolve, reject) => {
      window.gapi.load('client', { callback: resolve, onerror: reject })
    })

    await window.gapi.client.init({
      apiKey: GOOGLE_CONFIG.apiKey,
      discoveryDocs: [GOOGLE_DISCOVERY_DOC]
    })

    googleTokenClient.current = window.google.accounts.oauth2.initTokenClient({
      client_id: GOOGLE_CONFIG.clientId,
      scope: GOOGLE_SCOPES,
      callback: () => {}
    })

    setGoogleReady(true)
    setGoogleStatus('ready')
    setGoogleMessage('Google準備OK')
    return googleTokenClient.current
  }

  async function requestGoogleAccess() {
    const tokenClient = await initializeGoogleCalendar()

    return new Promise((resolve, reject) => {
      tokenClient.callback = response => {
        if (response.error) {
          reject(new Error(response.error))
          return
        }
        setGoogleConnected(true)
        setGoogleStatus('connected')
        setGoogleMessage('Google連携済み')
        resolve(response)
      }

      const token = window.gapi.client.getToken()
      tokenClient.requestAccessToken({ prompt: token ? '' : 'consent' })
    })
  }

  async function importGoogleWeek() {
    try {
      setGoogleStatus('syncing')
      setGoogleMessage('今週を読込中')
      await requestGoogleAccess()

      const start = new Date(weekDates[0])
      const end = new Date(weekDates[6])
      start.setHours(0, 0, 0, 0)
      end.setDate(end.getDate() + 1)
      end.setHours(0, 0, 0, 0)

      const response = await window.gapi.client.calendar.events.list({
        calendarId: 'primary',
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        showDeleted: false,
        singleEvents: true,
        maxResults: 250,
        orderBy: 'startTime'
      })

      const weekDateSet = new Set(weekDates.map(day => formatISO(day)))
      const importedEvents = (response.result.items || [])
        .map(normalizeGoogleEvent)
        .filter(item => item && weekDateSet.has(item.date))

      setEvents(prev => [
        ...prev.filter(item => item.source !== GOOGLE_EVENT_SOURCE || !weekDateSet.has(item.date)),
        ...importedEvents
      ])

      setGoogleStatus('connected')
      setGoogleMessage(`${importedEvents.length}件の予定を読込済み`)
    } catch (error) {
      setGoogleStatus('error')
      setGoogleMessage(error.message || 'Googleエラー')
    }
  }

  function disconnectGoogleCalendar() {
    const token = window.gapi?.client?.getToken()
    if (token) {
      window.google?.accounts?.oauth2?.revoke(token.access_token)
      window.gapi.client.setToken('')
    }
    setGoogleConnected(false)
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

  function eventsFor(dateISO) {
    return events
      .filter(item => item.date === dateISO)
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
            <button
              type="button"
              onClick={importGoogleWeek}
              disabled={!googleConfigured || googleStatus === 'loading' || googleStatus === 'syncing'}
            >
              {googleConnected ? '今週を読込' : '連携する'}
            </button>
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
                    const dragStart = isDragActive ? Math.min(dragSelection.anchorHour, dragSelection.currentHour) : 0
                    const dragEnd = isDragActive ? Math.max(dragSelection.anchorHour, dragSelection.currentHour) + 1 : 0
                    return (
                      <div className={`day-column ${tone}`} key={iso}>
                        <div className={`day-header ${tone}`}>
                          <span>{day.toLocaleDateString('ja-JP', { weekday: 'short' })}</span>
                          <strong>{day.getDate()}</strong>
                        </div>
                        <div className="day-body">
                          {HOURS.map(hour => (
                            <div
                              key={hour}
                              className="slot"
                              style={{ height: ROW_HEIGHT + 'px' }}
                              onMouseDown={e => {
                                e.preventDefault()
                                setDragSelection({ date: iso, anchorHour: hour, currentHour: hour })
                              }}
                              onMouseEnter={() => {
                                setDragSelection(prev => {
                                  if (!prev || prev.date !== iso) return prev
                                  return { ...prev, currentHour: hour }
                                })
                              }}
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
                                top: (dragStart - HOURS[0]) * ROW_HEIGHT + 'px',
                                height: (dragEnd - dragStart) * ROW_HEIGHT + 'px'
                              }}
                            />
                          )}

                          {dayEvents.map(ev => {
                            const top = (minutesFromTime(ev.startTime) - HOURS[0] * 60) / 60 * ROW_HEIGHT
                            const height = (minutesFromTime(ev.endTime) - minutesFromTime(ev.startTime)) / 60 * ROW_HEIGHT
                            return (
                              <div
                                key={ev.id}
                                className={`event-block ${ev.source === GOOGLE_EVENT_SOURCE ? 'google-event' : ''}`}
                                style={{ top: top + 'px', height: Math.max(20, height) + 'px' }}
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
