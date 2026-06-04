import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const EVENT_STORAGE_KEY = 'wdp_events_v1'
const TASK_STORAGE_KEY = 'wdp_tasks_v1'
const MEMO_STORAGE_KEY = 'wdp_memos_v1'
const REMINDER_FIRED_STORAGE_KEY = 'wdp_reminders_fired_v1'
const GOOGLE_CONNECTED_STORAGE_KEY = 'wdp_google_connected_v1'
const UNDATED_TASK_DATE = '__undated__'
const SHARED_MEMO_KEY = '__shared_memo__'
const DASHBOARD_MEMO_PREFIX = 'dashboardMemo_'
const GOOGLE_EVENT_SOURCE = 'google-calendar'
const GOOGLE_DISCOVERY_DOC = 'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'
const GOOGLE_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
const GOOGLE_SCOPES = GOOGLE_EVENTS_SCOPE
const GOOGLE_TIME_ZONE = 'Asia/Tokyo'
const GOOGLE_EVENTS_URL = 'https://www.googleapis.com/calendar/v3/calendars/primary/events'
const UNDO_STACK_LIMIT = 50
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

function dateFromISO(dateISO) {
  const [year, month, day] = dateISO.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function dashboardMemoStorageKey(dateISO) {
  return `${DASHBOARD_MEMO_PREFIX}${dateISO}`
}

function storedDashboardMemos() {
  const dashboardMemos = {}

  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i)
    if (key?.startsWith(DASHBOARD_MEMO_PREFIX)) {
      dashboardMemos[key] = localStorage.getItem(key) || ''
    }
  }

  return dashboardMemos
}

function startOfMonth(date) {
  const d = new Date(date)
  d.setDate(1)
  d.setHours(0, 0, 0, 0)
  return d
}

function dateInMonth(date, preferredDay = 1) {
  const year = date.getFullYear()
  const month = date.getMonth()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  return formatISO(new Date(year, month, Math.min(preferredDay, daysInMonth)))
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
const START_TIME_OPTIONS = TIME_OPTIONS.slice(0, -1)
const DEFAULT_EVENT_REMINDER_OFFSETS = [30, 10, 5]
const EVENT_REMINDER_CHOICES = [
  { value: 60, label: '1時間前' },
  { value: 30, label: '30分前' },
  { value: 10, label: '10分前' },
  { value: 5, label: '5分前' }
]
const REMINDER_GRACE_MS = 90 * 1000
const GOOGLE_AUTO_SYNC_INTERVAL_MS = 60 * 1000
const MOBILE_LONG_PRESS_MS = 380
const MOBILE_LONG_PRESS_MOVE_TOLERANCE = 12

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

function mobilePointerPosition(e, timeline) {
  const timelineRect = timeline.getBoundingClientRect()
  const rows = Array.from(timeline.querySelectorAll('.mobile-hour-row'))
  const fallbackRow = e.clientY < timelineRect.top ? rows[0] : rows[rows.length - 1]
  const activeRow = rows.find(row => {
    const rect = row.getBoundingClientRect()
    return e.clientY >= rect.top && e.clientY <= rect.bottom
  }) || fallbackRow

  if (!activeRow) {
    return {
      minutes: GRID_START_MINUTES,
      y: 0
    }
  }

  const rowRect = activeRow.getBoundingClientRect()
  const hour = Number(activeRow.dataset.hour || GRID_START_MINUTES / 60)
  const ratio = clamp((e.clientY - rowRect.top) / Math.max(rowRect.height, 1), 0, 1)
  const y = clamp(e.clientY - timelineRect.top, 0, timelineRect.height)

  return {
    minutes: clampGridMinutes(hour * 60 + ratio * 60),
    y
  }
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

function hasGoogleCalendarEventsScope(tokenResponse) {
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

async function googleCalendarApiError(response, fallbackMessage) {
  const errorBody = await response.json().catch(() => null)
  const message = errorBody?.error?.message || fallbackMessage
  console.error('Google sync failed', {
    status: response.status,
    statusText: response.statusText,
    errorBody,
    message
  })

  const error = new Error(message)
  error.status = response.status
  error.statusText = response.statusText
  error.errorBody = errorBody
  error.response = errorBody
  return error
}

function googleSyncErrorInfo(error) {
  const errorBody = error?.errorBody || error?.response || null
  const status = error?.status || errorBody?.error?.code || null
  const statusText = error?.statusText || ''
  const message = errorBody?.error?.message || error?.message || ''

  return { status, statusText, errorBody, message }
}

function googleSyncErrorReason(errorBody) {
  const errors = errorBody?.error?.errors
  if (Array.isArray(errors)) {
    return errors.map(item => item.reason || item.message || '').join(' ')
  }

  return errorBody?.error?.status || ''
}

function googleSyncDisplayMessage(error, fallbackMessage = 'Google同期に失敗しました。詳細はConsoleを確認してください。') {
  const { status, errorBody, message } = googleSyncErrorInfo(error)
  const reason = googleSyncErrorReason(errorBody)
  const text = `${message} ${reason}`.toLowerCase()

  if (error?.reauthRequired || message === 'Google再認証が必要です') {
    return 'Google再認証が必要です'
  }

  if (status === 401) {
    return 'Google連携の有効期限が切れています。再認証してください。'
  }

  if (status === 403 && (
    text.includes('accessnotconfigured') ||
    text.includes('api not enabled') ||
    text.includes('has not been used') ||
    text.includes('disabled') ||
    text.includes('enable')
  )) {
    return 'Google Calendar APIが有効化されていない可能性があります。Google Cloud Consoleを確認してください。'
  }

  if (status === 403 && (
    text.includes('insufficient') ||
    text.includes('scope') ||
    text.includes('permission') ||
    text.includes('forbidden')
  )) {
    return 'Googleカレンダーの権限が不足しています。もう一度Google連携してください。'
  }

  if (status === 400) {
    return '予定データの形式に問題があります。開始時間・終了時間を確認してください。'
  }

  if (!status && (
    error?.name === 'TypeError' ||
    text.includes('failed to fetch') ||
    text.includes('network') ||
    text.includes('load failed')
  )) {
    return 'ネットワーク接続に問題があります。時間を置いてもう一度試してください。'
  }

  return fallbackMessage
}

function logGoogleSyncFailure(error) {
  const { status, statusText, errorBody, message } = googleSyncErrorInfo(error)
  console.error('Google sync failed', {
    status,
    statusText,
    errorBody,
    message
  })
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
  if (!response.ok) {
    throw await googleCalendarApiError(response, 'Google Calendar insert failed')
  }

  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google Calendar insert response', responseBody)
  console.log('Google events.insert response', responseBody)

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
  if (!response.ok) {
    throw await googleCalendarApiError(response, 'Google Calendar list failed')
  }

  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.list response', responseBody)

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
  if (!response.ok) {
    throw await googleCalendarApiError(response, 'Google Calendar update failed')
  }

  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.patch response', responseBody)

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
  if (!response.ok) {
    throw await googleCalendarApiError(response, 'Google Calendar delete failed')
  }

  const responseBody = await readGoogleCalendarResponse(response)

  console.log('Google events.delete response', {
    ok: response.ok,
    status: response.status,
    body: responseBody
  })

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

function dedupeEventsForDisplay(eventList) {
  const normalizedEvents = eventList.map(normalizePlannerEvent)
  const googleSyncedSignatures = new Set(
    normalizedEvents
      .filter(event => event.googleEventId)
      .map(eventSyncSignature)
  )
  const seenKeys = new Set()

  return normalizedEvents.filter(event => {
    const signature = eventSyncSignature(event)
    const signatureKey = `signature:${signature}`

    if (!event.googleEventId && googleSyncedSignatures.has(signature)) {
      return false
    }

    const googleKey = event.googleEventId ? `google:${event.googleEventId}` : ''
    if ((googleKey && seenKeys.has(googleKey)) || seenKeys.has(signatureKey)) {
      return false
    }

    if (googleKey) seenKeys.add(googleKey)
    seenKeys.add(signatureKey)
    return true
  })
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

function taskDateKey(task) {
  return task.date || UNDATED_TASK_DATE
}

function removeTaskDate(task) {
  const nextTask = { ...task }
  delete nextTask.date
  return nextTask
}

function cloneUndoData(value) {
  return JSON.parse(JSON.stringify(value))
}

function taskOrderValue(task, fallbackIndex = 0) {
  const order = Number(task.order)
  return Number.isFinite(order) ? order : (fallbackIndex + 1) * 1000
}

function sortTasksByOrder(tasks) {
  return tasks
    .map((task, index) => ({ task, index }))
    .sort((a, b) => {
      const orderDiff = taskOrderValue(a.task, a.index) - taskOrderValue(b.task, b.index)
      if (orderDiff !== 0) return orderDiff
      return a.index - b.index
    })
    .map(item => item.task)
}

function normalizeTasks(tasks) {
  if (!Array.isArray(tasks)) return []
  const counters = new Map()

  return tasks.map(task => {
    const key = taskDateKey(task)
    const count = counters.get(key) || 0
    counters.set(key, count + 1)
    const order = taskOrderValue(task, count)
    return {
      ...task,
      id: task.id || createLocalId('task'),
      title: task.title || '',
      completed: Boolean(task.completed),
      order
    }
  })
}

function nextTaskOrder(tasks, dateISO) {
  const orders = tasks
    .filter(task => taskDateKey(task) === dateISO)
    .map((task, index) => taskOrderValue(task, index))

  return orders.length ? Math.max(...orders) + 1000 : 1000
}

function tasksWithReorderedGroup(tasks, dateISO, orderedGroup) {
  const orderedIds = new Set(orderedGroup.map(task => task.id))
  const otherTasks = tasks.filter(task => taskDateKey(task) !== dateISO && !orderedIds.has(task.id))
  const groupWithOrder = orderedGroup.map((task, index) => ({
    ...task,
    order: (index + 1) * 1000
  }))

  return [...otherTasks, ...groupWithOrder]
}

function moveTaskInList(tasks, taskId, targetDateISO, beforeTaskId = null) {
  const movingTask = tasks.find(task => task.id === taskId)
  if (!movingTask) return { tasks, changed: false }

  const movingDateISO = taskDateKey(movingTask)
  if (beforeTaskId === taskId) {
    return { tasks, changed: false }
  }
  if (movingDateISO === targetDateISO && !beforeTaskId) {
    const sameDateTasks = sortTasksByOrder(tasks.filter(task => taskDateKey(task) === targetDateISO))
    if (sameDateTasks[sameDateTasks.length - 1]?.id === taskId) {
      return { tasks, changed: false }
    }
  }
  if (movingDateISO === targetDateISO && beforeTaskId) {
    const sameDateTasks = sortTasksByOrder(tasks.filter(task => taskDateKey(task) === targetDateISO))
    const movingIndex = sameDateTasks.findIndex(task => task.id === taskId)
    const beforeIndex = sameDateTasks.findIndex(task => task.id === beforeTaskId)
    if (movingIndex >= 0 && beforeIndex === movingIndex + 1) {
      return { tasks, changed: false }
    }
  }
  if (movingDateISO !== targetDateISO && beforeTaskId === taskId) {
    return { tasks, changed: false }
  }

  const targetGroup = sortTasksByOrder(tasks.filter(task => (
    task.id !== taskId && taskDateKey(task) === targetDateISO
  )))
  const movedTask = targetDateISO === UNDATED_TASK_DATE
    ? removeTaskDate(movingTask)
    : { ...movingTask, date: targetDateISO }
  const insertIndex = beforeTaskId
    ? targetGroup.findIndex(task => task.id === beforeTaskId)
    : targetGroup.length
  const safeInsertIndex = insertIndex < 0 ? targetGroup.length : insertIndex
  const nextGroup = [...targetGroup]
  nextGroup.splice(safeInsertIndex, 0, movedTask)

  return {
    tasks: tasksWithReorderedGroup(tasks.filter(task => task.id !== taskId), targetDateISO, nextGroup),
    changed: true
  }
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
    return raw ? normalizeTasks(JSON.parse(raw)) : []
  } catch {
    return []
  }
}

function defaultMemos() {
  try {
    const raw = localStorage.getItem(MEMO_STORAGE_KEY)
    const dashboardMemos = storedDashboardMemos()
    if (!raw) return dashboardMemos

    const parsed = JSON.parse(raw)
    if (parsed[SHARED_MEMO_KEY] !== undefined) return { ...parsed, ...dashboardMemos }

    const thisWeekKey = formatISO(startOfWeek(new Date()))
    const fallbackMemo = parsed[thisWeekKey] || Object.values(parsed).find(value => (
      typeof value === 'string' && value.trim()
    )) || ''

    return { ...parsed, ...dashboardMemos, [SHARED_MEMO_KEY]: fallbackMemo }
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
  if (connected) {
    localStorage.setItem(GOOGLE_CONNECTED_STORAGE_KEY, 'true')
  } else {
    localStorage.removeItem(GOOGLE_CONNECTED_STORAGE_KEY)
  }
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
  const googleConnectedRef = useRef(googleConfigured && defaultGoogleConnected())
  const eventsRef = useRef([])
  const dragUpdatedEventRef = useRef(null)
  const pendingGoogleInsertIdsRef = useRef(new Set())
  const updateGoogleEventRef = useRef(null)
  const syncCurrentWeekWithGoogleRef = useRef(null)
  const isSyncingRef = useRef(false)
  const mobileLongPressTimerRef = useRef(null)
  const mobileDragStartRef = useRef(null)
  const mobileDragSelectionRef = useRef(null)
  const [centerDate, setCenterDate] = useState(() => {
    const today = startOfWeek(new Date())
    if (today < MIN_WEEK) return MIN_WEEK
    if (today > MAX_WEEK) return MAX_WEEK
    return today
  })
  const [events, setEvents] = useState(() => defaultEvents())
  const [tasks, setTasks] = useState(() => defaultTasks())
  const [memos, setMemos] = useState(() => defaultMemos())
  const [, setUndoStack] = useState([])
  const [editing, setEditing] = useState(null)
  const [dragSelection, setDragSelection] = useState(null)
  const [dragState, setDragState] = useState(null)
  const [draggedTaskId, setDraggedTaskId] = useState(null)
  const [dragOverTaskId, setDragOverTaskId] = useState(null)
  const [dragOverTaskEndDate, setDragOverTaskEndDate] = useState(null)
  const dragSelectionBodyRef = useRef(null)
  const dragSelectionRef = useRef(null)
  const draggedTaskIdRef = useRef(null)
  const undoStackRef = useRef([])
  const undoActionRef = useRef(null)
  const [now, setNow] = useState(new Date())
  const [taskDrafts, setTaskDrafts] = useState({})
  const [firedReminders, setFiredReminders] = useState(() => defaultFiredReminders())
  const [activeReminders, setActiveReminders] = useState([])
  const [notificationPermission, setNotificationPermission] = useState(() => (
    'Notification' in window ? window.Notification.permission : 'unsupported'
  ))
  const [googleReady, setGoogleReady] = useState(false)
  const [googleConnected, setGoogleConnected] = useState(() => googleConfigured && defaultGoogleConnected())
  const [googleStatus, setGoogleStatus] = useState(() => {
    if (!googleConfigured) return 'missing-config'
    return defaultGoogleConnected() ? 'connected' : 'idle'
  })
  const [googleMessage, setGoogleMessage] = useState(() => {
    if (!googleConfigured) return 'Google設定待ち'
    return defaultGoogleConnected() ? 'Google連携済み' : 'Google準備OK'
  })
  const [isSyncing, setIsSyncing] = useState(false)
  const [currentView, setCurrentView] = useState('planner')
  const [selectedDashboardDate, setSelectedDashboardDate] = useState(() => formatISO(new Date()))
  const [dashboardCalendarMonth, setDashboardCalendarMonth] = useState(() => startOfMonth(new Date()))
  const [monthViewMonth, setMonthViewMonth] = useState(() => startOfMonth(new Date()))
  const [selectedMonthDate, setSelectedMonthDate] = useState(() => formatISO(new Date()))
  const [dashboardCopyMessage, setDashboardCopyMessage] = useState('')
  const [dashboardEventDraft, setDashboardEventDraft] = useState({
    title: '',
    startTime: '09:00',
    endTime: '10:00'
  })
  const [dashboardTaskDraft, setDashboardTaskDraft] = useState('')
  const [monthEventDraft, setMonthEventDraft] = useState({
    title: '',
    startTime: '09:00',
    endTime: '10:00'
  })
  const [mobileActivePage, setMobileActivePage] = useState('events')
  const [mobileEventDraft, setMobileEventDraft] = useState({
    title: '',
    startTime: '09:00',
    endTime: '10:00'
  })
  const [mobileTaskDraft, setMobileTaskDraft] = useState('')
  const [mobileDragSelection, setMobileDragSelection] = useState(null)
  const [mobilePendingEvent, setMobilePendingEvent] = useState(null)
  const [mobilePendingTitle, setMobilePendingTitle] = useState('')

  useEffect(() => saveEvents(events), [events])
  useEffect(() => saveTasks(tasks), [tasks])
  useEffect(() => saveMemos(memos), [memos])
  useEffect(() => saveFiredReminders(firedReminders), [firedReminders])
  useEffect(() => saveGoogleConnected(googleConnected), [googleConnected])
  useEffect(() => () => {
    if (mobileLongPressTimerRef.current) {
      window.clearTimeout(mobileLongPressTimerRef.current)
    }
  }, [])

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
  const selectedMobileDate = currentDateISO
  const currentHour = now.getHours()
  const currentMinutes = now.getHours() * 60 + now.getMinutes()
  const selectedDashboardDateLabel = dateFromISO(selectedDashboardDate).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })
  const dashboardMemoKey = dashboardMemoStorageKey(selectedDashboardDate)
  const dashboardMemoText = memos[dashboardMemoKey] || ''
  const dashboardMonthLabel = dashboardCalendarMonth.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long'
  })
  const selectedDashboardEvents = useMemo(() => (
    events
      .filter(item => item.date === selectedDashboardDate)
      .map(normalizePlannerEvent)
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  ), [events, selectedDashboardDate])
  const selectedDashboardTasks = useMemo(() => (
    sortTasksByOrder(tasks.filter(item => item.date === selectedDashboardDate))
  ), [tasks, selectedDashboardDate])
  const selectedMobileDateLabel = dateFromISO(selectedMobileDate).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })
  const selectedMobileEvents = dedupeEventsForDisplay(events.filter(item => item.date === selectedMobileDate))
    .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  const selectedMobileTasks = sortTasksByOrder(tasks.filter(item => item.date === selectedMobileDate))
  const mobileMemoKey = dashboardMemoStorageKey(selectedMobileDate)
  const mobileMemoText = memos[mobileMemoKey] || ''
  const mobileDragRange = mobileDragSelection
    ? eventRangeFromSelection(mobileDragSelection.anchorMinutes, mobileDragSelection.currentMinutes)
    : null
  const mobileDragPreviewStyle = mobileDragSelection
    ? {
        top: Math.min(mobileDragSelection.anchorY, mobileDragSelection.currentY) + 'px',
        height: Math.max(24, Math.abs(mobileDragSelection.currentY - mobileDragSelection.anchorY)) + 'px'
      }
    : null
  const draggedTask = useMemo(() => (
    tasks.find(item => item.id === draggedTaskId) || null
  ), [tasks, draggedTaskId])
  const canDropTaskToSelectedDate = Boolean(draggedTask && taskDateKey(draggedTask) !== selectedDashboardDate)
  const dashboardCalendarCells = useMemo(() => {
    const year = dashboardCalendarMonth.getFullYear()
    const month = dashboardCalendarMonth.getMonth()
    const firstDay = new Date(year, month, 1)
    const leadingBlanks = (firstDay.getDay() + 6) % 7
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = Array.from({ length: leadingBlanks }, () => null)

    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push(formatISO(new Date(year, month, day)))
    }

    while (cells.length % 7 !== 0) {
      cells.push(null)
    }

    return cells
  }, [dashboardCalendarMonth])
  const dashboardEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(dashboardEventDraft.startTime))
  ), [dashboardEventDraft.startTime])
  const monthEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(monthEventDraft.startTime))
  ), [monthEventDraft.startTime])
  const mobileEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(mobileEventDraft.startTime))
  ), [mobileEventDraft.startTime])
  const monthViewTitle = monthViewMonth.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long'
  })
  const monthCalendarCells = useMemo(() => {
    const year = monthViewMonth.getFullYear()
    const month = monthViewMonth.getMonth()
    const firstDay = new Date(year, month, 1)
    const leadingBlanks = firstDay.getDay()
    const daysInMonth = new Date(year, month + 1, 0).getDate()
    const cells = Array.from({ length: leadingBlanks }, () => null)

    for (let day = 1; day <= daysInMonth; day += 1) {
      cells.push(formatISO(new Date(year, month, day)))
    }

    while (cells.length % 7 !== 0) {
      cells.push(null)
    }

    return cells
  }, [monthViewMonth])
  const selectedMonthDateLabel = dateFromISO(selectedMonthDate).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    weekday: 'long'
  })
  const selectedMonthDateShortLabel = dateFromISO(selectedMonthDate).toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const selectedMonthEvents = useMemo(() => (
    dedupeEventsForDisplay(events.filter(item => item.date === selectedMonthDate))
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  ), [events, selectedMonthDate])

  function createUndoSnapshot() {
    return {
      events: cloneUndoData(events),
      tasks: cloneUndoData(tasks),
      memos: cloneUndoData(memos),
      centerDateISO: formatISO(centerDate),
      selectedDashboardDate,
      dashboardCalendarMonthISO: formatISO(dashboardCalendarMonth),
      monthViewMonthISO: formatISO(monthViewMonth),
      selectedMonthDate,
      currentView
    }
  }

  function saveUndoSnapshot() {
    const snapshot = createUndoSnapshot()
    setUndoStack(prev => {
      const next = [...prev, snapshot].slice(-UNDO_STACK_LIMIT)
      undoStackRef.current = next
      return next
    })
  }

  function performUndo() {
    const stack = undoStackRef.current
    if (!stack.length) return

    const snapshot = stack[stack.length - 1]
    const nextStack = stack.slice(0, -1)
    const restoredEvents = cloneUndoData(snapshot.events)
    const restoredTasks = cloneUndoData(snapshot.tasks)
    const restoredMemos = cloneUndoData(snapshot.memos)

    undoStackRef.current = nextStack
    setUndoStack(nextStack)
    eventsRef.current = restoredEvents
    setEvents(restoredEvents)
    setTasks(restoredTasks)
    setMemos(restoredMemos)
    setCenterDate(startOfWeek(dateFromISO(snapshot.centerDateISO)))
    setSelectedDashboardDate(snapshot.selectedDashboardDate)
    setDashboardCalendarMonth(startOfMonth(dateFromISO(snapshot.dashboardCalendarMonthISO)))
    setMonthViewMonth(startOfMonth(dateFromISO(snapshot.monthViewMonthISO)))
    setSelectedMonthDate(snapshot.selectedMonthDate)
    setCurrentView(snapshot.currentView || 'planner')
    setEditing(null)
    setDragState(null)
    setDragSelection(null)
    draggedTaskIdRef.current = null
    setDraggedTaskId(null)
    setDragOverTaskId(null)
    setDragOverTaskEndDate(null)
    setDashboardCopyMessage('')
  }

  useEffect(() => {
    undoActionRef.current = performUndo
  })

  useEffect(() => {
    function handleUndoShortcut(e) {
      const key = e.key.toLowerCase()
      const isUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && key === 'z'
      if (!isUndo || undoStackRef.current.length === 0) return

      e.preventDefault()
      undoActionRef.current?.()
    }

    window.addEventListener('keydown', handleUndoShortcut)
    return () => window.removeEventListener('keydown', handleUndoShortcut)
  }, [])

  useEffect(() => {
    function clearPrimedTaskAfterPointerUp() {
      window.setTimeout(() => {
        draggedTaskIdRef.current = null
        setDraggedTaskId(null)
        setDragOverTaskId(null)
        setDragOverTaskEndDate(null)
      }, 0)
    }

    window.addEventListener('pointerup', clearPrimedTaskAfterPointerUp)
    return () => window.removeEventListener('pointerup', clearPrimedTaskAfterPointerUp)
  }, [])

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
    saveUndoSnapshot()

    if (!isNewEvent) {
      setEvents(prev => prev.map(item => (item.id === ev.id ? normalizedEvent : item)))
      if (normalizedEvent.googleEventId) {
        void updateEventInGoogleCalendar(normalizedEvent)
      }
    } else {
      const id = createLocalId('event')
      const localEvent = { ...normalizedEvent, id }
      const accessToken = currentGoogleAccessToken()
      const isGoogleConnected = isGoogleSyncConnected()

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
    if (!event) return
    saveUndoSnapshot()
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

  function isGoogleSyncConnected() {
    const token = window.gapi?.client?.getToken()
    return googleConnectedRef.current || hasGoogleCalendarEventsScope(token)
  }

  function setGoogleSyncFailure(error, fallbackMessage) {
    logGoogleSyncFailure(error)
    const message = googleSyncDisplayMessage(error, fallbackMessage)
    const { status } = googleSyncErrorInfo(error)

    if (status === 401 || message.includes('再認証')) {
      googleAccessTokenRef.current = ''
      window.gapi?.client?.setToken(null)
      setGoogleStatus('reauth')
    } else {
      setGoogleStatus('error')
    }

    setGoogleMessage(message)
  }

  async function reauthenticateGoogleCalendar() {
    try {
      setGoogleStatus('loading')
      setGoogleMessage('Google再認証中')
      await requestGoogleAccess({ prompt: 'consent' })
      await syncCurrentWeekWithGoogle({ automatic: false })
    } catch (error) {
      console.error('Google Calendar reauth failed', error)
      setGoogleSyncFailure(error, 'Google再認証が必要です')
    }
  }

  async function ensureGoogleAccessToken(options = {}) {
    let token = window.gapi?.client?.getToken()
    if (!hasGoogleCalendarEventsScope(token) || !currentGoogleAccessToken()) {
      await requestGoogleAccess(options)
      token = window.gapi?.client?.getToken()
    }

    const accessToken = currentGoogleAccessToken()
    const isGoogleConnected = googleConnectedRef.current || hasGoogleCalendarEventsScope(token)
    console.log('google connected', isGoogleConnected)
    console.log('access token exists', Boolean(accessToken))

    if (!accessToken) {
      const error = new Error('Google再認証が必要です')
      error.status = 401
      error.reauthRequired = true
      throw error
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
          const error = new Error(response.error)
          error.status = response.error === 'interaction_required' ? 401 : null
          error.reauthRequired = response.error === 'interaction_required'
          error.errorBody = { error: response }
          reject(error)
          return
        }

        if (!hasGoogleCalendarEventsScope(response)) {
          console.log('Google Identity Services token missing calendar.events scope', response)
          const error = new Error('Googleカレンダーの追加権限が許可されていません')
          error.status = 403
          error.errorBody = {
            error: {
              message: error.message,
              errors: [{ reason: 'insufficientPermissions', message: error.message }]
            }
          }
          reject(error)
          return
        }

        if (response.access_token) {
          googleAccessTokenRef.current = response.access_token
          window.gapi?.client?.setToken(response)
        }

        console.log('Google Identity Services token granted calendar.events scope', {
          scope: response.scope
        })
        saveGoogleConnected(true)
        googleConnectedRef.current = true
        setGoogleConnected(true)
        setGoogleStatus('connected')
        setGoogleMessage('Google連携済み')
        resolve(response)
      }

      const token = window.gapi.client.getToken()
      const prompt = options.prompt ?? (hasGoogleCalendarEventsScope(token) ? '' : 'consent')
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
      saveGoogleConnected(true)
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
      setGoogleSyncFailure(error, 'Googleカレンダーへの追加に失敗しました。Consoleを確認してください。')
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
      setGoogleSyncFailure(error, 'Googleカレンダーの更新に失敗しました。Consoleを確認してください。')
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
      setGoogleSyncFailure(error, 'Googleカレンダーの削除に失敗しました。Consoleを確認してください。')
    }
  }

  async function syncUnsyncedPlannerEventsToGoogle(localEvents, weekDateSet, accessToken) {
    let syncedCount = 0
    let failureCount = 0
    let lastError = null
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
        lastError = error
        console.error('Google Calendar insert failed', error)
        logGoogleSyncFailure(error)
      } finally {
        pendingGoogleInsertIdsRef.current.delete(event.id)
      }
    }

    return { events: nextEvents, syncedCount, failureCount, lastError }
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

    const isGoogleConnected = isGoogleSyncConnected()

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
      let token = window.gapi?.client?.getToken()
      if (!accessToken || !hasGoogleCalendarEventsScope(token)) {
        try {
          accessToken = await ensureGoogleAccessToken({
            prompt: automatic ? '' : undefined,
            silent: automatic
          })
        } catch (error) {
          console.error('Google Calendar token refresh failed', error)
          if (automatic) console.log('auto sync skipped: no access token')
          setGoogleSyncFailure(error, 'Google再認証が必要です')
          return
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
      if (syncResult.failureCount > 0) {
        setGoogleSyncFailure(syncResult.lastError, '同期失敗：詳細はConsoleを確認')
      } else {
        setGoogleStatus('connected')
        setGoogleMessage(`最終同期: ${formatClock(new Date())}`)
      }
    } catch (error) {
      console.error('auto sync failed', error)
      console.error('Google Calendar list failed', error)
      setGoogleSyncFailure(error, '同期失敗：詳細はConsoleを確認')
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
    saveGoogleConnected(false)
    setGoogleStatus(googleReady ? 'ready' : 'idle')
    setGoogleMessage('Google準備OK')
  }

  function startEventDrag(e, ev, type) {
    e.stopPropagation()
    e.preventDefault()
    const dayBody = e.currentTarget.closest('.day-body')
    if (!dayBody) return
    saveUndoSnapshot()
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
    return dedupeEventsForDisplay(events.filter(item => item.date === dateISO))
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  }

  function tasksFor(dateISO) {
    return sortTasksByOrder(tasks.filter(item => item.date === dateISO))
  }

  function undatedTasks() {
    return sortTasksByOrder(tasks.filter(item => !item.date || item.date === UNDATED_TASK_DATE))
  }

  function updateTaskDraft(dateISO, value) {
    setTaskDrafts(prev => ({ ...prev, [dateISO]: value }))
  }

  function addTask(dateISO) {
    const title = (taskDrafts[dateISO] || '').trim()
    if (!title) return
    saveUndoSnapshot()
    const id = createLocalId('task')
    setTasks(prev => {
      const task = dateISO === UNDATED_TASK_DATE
        ? { id, title, completed: false, order: nextTaskOrder(prev, dateISO) }
        : { id, date: dateISO, title, completed: false, order: nextTaskOrder(prev, dateISO) }
      return [...prev, task]
    })
    updateTaskDraft(dateISO, '')
  }

  function setActiveDraggedTask(taskId) {
    draggedTaskIdRef.current = taskId
    setDraggedTaskId(taskId)
  }

  function clearActiveDraggedTask() {
    draggedTaskIdRef.current = null
    setDraggedTaskId(null)
    setDragOverTaskId(null)
    setDragOverTaskEndDate(null)
  }

  function primeTaskMove(e, taskId) {
    if (e.button !== undefined && e.button !== 0) return
    if (e.target.closest('button, input')) return
    setActiveDraggedTask(taskId)
  }

  function startTaskDrag(e, taskId) {
    e.stopPropagation()
    setActiveDraggedTask(taskId)
    e.dataTransfer.effectAllowed = 'move'
    const task = tasks.find(item => item.id === taskId)
    const source = taskDateKey(task || {}) === UNDATED_TASK_DATE ? 'unscheduled' : 'scheduled'
    e.dataTransfer.setData('taskId', taskId)
    e.dataTransfer.setData('source', source)
    e.dataTransfer.setData('application/x-weekly-daily-task', taskId)
    e.dataTransfer.setData('text/plain', taskId)
    e.dataTransfer.setData('text', taskId)
  }

  function allowTaskDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    e.dataTransfer.dropEffect = 'move'
  }

  function moveTaskById(taskId, dateISO) {
    if (!taskId) return
    const task = tasks.find(item => item.id === taskId)
    if (!task) {
      clearActiveDraggedTask()
      return
    }
    const result = moveTaskInList(tasks, taskId, dateISO)
    if (!result.changed) {
      clearActiveDraggedTask()
      return
    }

    saveUndoSnapshot()
    setTasks(result.tasks)
    clearActiveDraggedTask()
  }

  function moveTaskToDate(e, dateISO) {
    e.preventDefault()
    e.stopPropagation()
    const taskId = e.dataTransfer.getData('taskId')
      || e.dataTransfer.getData('application/x-weekly-daily-task')
      || e.dataTransfer.getData('text/plain')
      || e.dataTransfer.getData('text')
      || draggedTaskIdRef.current
      || draggedTaskId
    moveTaskById(taskId, dateISO)
  }

  function moveTaskBeforeTask(e, targetTaskId, targetDateISO) {
    e.preventDefault()
    e.stopPropagation()
    const taskId = e.dataTransfer.getData('taskId')
      || e.dataTransfer.getData('application/x-weekly-daily-task')
      || e.dataTransfer.getData('text/plain')
      || e.dataTransfer.getData('text')
      || draggedTaskIdRef.current
      || draggedTaskId
    if (!taskId || taskId === targetTaskId) {
      clearActiveDraggedTask()
      return
    }

    const result = moveTaskInList(tasks, taskId, targetDateISO, targetTaskId)
    if (!result.changed) {
      clearActiveDraggedTask()
      return
    }

    saveUndoSnapshot()
    setTasks(result.tasks)
    clearActiveDraggedTask()
  }

  function markTaskDragOver(e, targetTaskId) {
    allowTaskDrop(e)
    if (draggedTaskId && draggedTaskId !== targetTaskId) {
      setDragOverTaskId(targetTaskId)
      setDragOverTaskEndDate(null)
    }
  }

  function markTaskEndDragOver(e, dateISO) {
    allowTaskDrop(e)
    if (draggedTaskId) {
      setDragOverTaskId(null)
      setDragOverTaskEndDate(dateISO)
    }
  }

  function dropPrimedTaskToDate(e, dateISO) {
    const taskId = draggedTaskIdRef.current || draggedTaskId
    if (!taskId) return

    e.preventDefault()
    e.stopPropagation()
    const task = tasks.find(item => item.id === taskId)
    if (!task || taskDateKey(task) === dateISO) {
      clearActiveDraggedTask()
      return
    }

    moveTaskById(taskId, dateISO)
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
    const target = tasks.find(item => item.id === id)
    if (!target) return
    saveUndoSnapshot()
    setTasks(prev => {
      return prev.map(item => (
        item.id === id ? { ...item, completed: !item.completed } : item
      ))
    })
  }

  function deleteTask(id) {
    if (!tasks.some(item => item.id === id)) return
    saveUndoSnapshot()
    setTasks(prev => prev.filter(item => item.id !== id))
  }

  function updateMemo(value) {
    if ((memos[SHARED_MEMO_KEY] || '') === value) return
    saveUndoSnapshot()
    setMemos(prev => ({ ...prev, [SHARED_MEMO_KEY]: value }))
  }

  function updateDashboardMemo(value) {
    if ((memos[dashboardMemoKey] || '') === value) return
    saveUndoSnapshot()
    localStorage.setItem(dashboardMemoKey, value)
    setMemos(prev => ({ ...prev, [dashboardMemoKey]: value }))
  }

  function changeDashboardMonth(offset) {
    setDashboardCalendarMonth(prev => {
      const next = new Date(prev)
      next.setMonth(next.getMonth() + offset)
      return startOfMonth(next)
    })
  }

  function selectDashboardDate(dateISO) {
    setSelectedDashboardDate(dateISO)
    setDashboardCopyMessage('')
  }

  function returnDashboardToToday() {
    const todayISO = formatISO(new Date())
    setSelectedDashboardDate(todayISO)
    setDashboardCalendarMonth(startOfMonth(dateFromISO(todayISO)))
    setDashboardCopyMessage('')
  }

  function changeMonthView(offset) {
    const next = new Date(monthViewMonth)
    next.setMonth(next.getMonth() + offset)
    const nextMonth = startOfMonth(next)

    setMonthViewMonth(nextMonth)
    setSelectedMonthDate(prev => dateInMonth(nextMonth, dateFromISO(prev).getDate()))
  }

  function returnMonthViewToToday() {
    const today = new Date()
    setMonthViewMonth(startOfMonth(today))
    setSelectedMonthDate(formatISO(today))
  }

  function selectMonthDate(dateISO) {
    setSelectedMonthDate(dateISO)
  }

  function updateDashboardEventStart(startTime) {
    setDashboardEventDraft(prev => {
      const startMinutes = minutesFromTime(startTime)
      const endMinutes = minutesFromTime(prev.endTime)
      const nextEndTime = endMinutes > startMinutes
        ? prev.endTime
        : minutesToTime(Math.min(startMinutes + STEP_MINUTES, GRID_END_MINUTES))

      return { ...prev, startTime, endTime: nextEndTime }
    })
  }

  function updateMonthEventStart(startTime) {
    setMonthEventDraft(prev => {
      const startMinutes = minutesFromTime(startTime)
      const endMinutes = minutesFromTime(prev.endTime)
      const nextEndTime = endMinutes > startMinutes
        ? prev.endTime
        : minutesToTime(Math.min(startMinutes + STEP_MINUTES, GRID_END_MINUTES))

      return { ...prev, startTime, endTime: nextEndTime }
    })
  }

  function updateMobileEventStart(startTime) {
    setMobileEventDraft(prev => {
      const startMinutes = minutesFromTime(startTime)
      const endMinutes = minutesFromTime(prev.endTime)
      const nextEndTime = endMinutes > startMinutes
        ? prev.endTime
        : minutesToTime(Math.min(startMinutes + STEP_MINUTES, GRID_END_MINUTES))

      return { ...prev, startTime, endTime: nextEndTime }
    })
  }

  function addDashboardEvent(e) {
    e.preventDefault()
    const title = dashboardEventDraft.title.trim()
    if (!title) return

    const normalizedTimes = normalizeEventTimeRange(
      dashboardEventDraft.startTime,
      dashboardEventDraft.endTime
    )

    saveEvent({
      id: null,
      date: selectedDashboardDate,
      title,
      ...normalizedTimes
    })
    setDashboardEventDraft(prev => ({ ...prev, title: '' }))
    setDashboardCopyMessage('')
  }

  function addMonthEvent(e) {
    e.preventDefault()
    const title = monthEventDraft.title.trim()
    if (!title) return

    const normalizedTimes = normalizeEventTimeRange(
      monthEventDraft.startTime,
      monthEventDraft.endTime
    )

    saveEvent({
      id: null,
      date: selectedMonthDate,
      title,
      ...normalizedTimes
    })
    setMonthEventDraft(prev => ({ ...prev, title: '' }))
  }

  function addMobileEvent(e) {
    e.preventDefault()
    const title = mobileEventDraft.title.trim()
    if (!title) return

    const normalizedTimes = normalizeEventTimeRange(
      mobileEventDraft.startTime,
      mobileEventDraft.endTime
    )

    saveEvent({
      id: null,
      date: selectedMobileDate,
      title,
      ...normalizedTimes
    })
    setMobileEventDraft(prev => ({ ...prev, title: '' }))
  }

  function addDashboardTask(e) {
    e.preventDefault()
    const title = dashboardTaskDraft.trim()
    if (!title) return

    saveUndoSnapshot()
    setTasks(prev => [
      ...prev,
      {
        id: createLocalId('task'),
        date: selectedDashboardDate,
        title,
        completed: false,
        order: nextTaskOrder(prev, selectedDashboardDate)
      }
    ])
    setDashboardTaskDraft('')
    setDashboardCopyMessage('')
  }

  function addMobileTask(e) {
    e.preventDefault()
    const title = mobileTaskDraft.trim()
    if (!title) return

    saveUndoSnapshot()
    setTasks(prev => [
      ...prev,
      {
        id: createLocalId('task'),
        date: selectedMobileDate,
        title,
        completed: false,
        order: nextTaskOrder(prev, selectedMobileDate)
      }
    ])
    setMobileTaskDraft('')
  }

  function updateMobileMemo(value) {
    if ((memos[mobileMemoKey] || '') === value) return
    saveUndoSnapshot()
    localStorage.setItem(mobileMemoKey, value)
    setMemos(prev => ({ ...prev, [mobileMemoKey]: value }))
  }

  function clearMobileLongPressTimer() {
    if (!mobileLongPressTimerRef.current) return
    window.clearTimeout(mobileLongPressTimerRef.current)
    mobileLongPressTimerRef.current = null
  }

  function resetMobileDragCreate() {
    clearMobileLongPressTimer()
    mobileDragStartRef.current = null
    mobileDragSelectionRef.current = null
    setMobileDragSelection(null)
  }

  function startMobileLongPressCreate(e) {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest('.mobile-event-card, input, select, button, textarea')) return

    const timeline = e.currentTarget
    const position = mobilePointerPosition(e, timeline)
    const startState = {
      pointerId: e.pointerId,
      timeline,
      originX: e.clientX,
      originY: e.clientY,
      anchorMinutes: position.minutes,
      anchorY: position.y
    }

    mobileDragStartRef.current = startState
    mobileDragSelectionRef.current = null
    setMobileDragSelection(null)
    clearMobileLongPressTimer()

    mobileLongPressTimerRef.current = window.setTimeout(() => {
      const nextSelection = {
        anchorMinutes: startState.anchorMinutes,
        currentMinutes: startState.anchorMinutes,
        anchorY: startState.anchorY,
        currentY: startState.anchorY
      }

      startState.timeline.setPointerCapture?.(startState.pointerId)
      mobileDragSelectionRef.current = nextSelection
      setMobileDragSelection(nextSelection)
      mobileLongPressTimerRef.current = null
    }, MOBILE_LONG_PRESS_MS)
  }

  function moveMobileLongPressCreate(e) {
    const startState = mobileDragStartRef.current
    if (!startState) return

    const distance = Math.hypot(e.clientX - startState.originX, e.clientY - startState.originY)
    if (!mobileDragSelectionRef.current && distance > MOBILE_LONG_PRESS_MOVE_TOLERANCE) {
      resetMobileDragCreate()
      return
    }

    if (!mobileDragSelectionRef.current) return

    e.preventDefault()
    const position = mobilePointerPosition(e, startState.timeline)
    const nextSelection = {
      ...mobileDragSelectionRef.current,
      currentMinutes: position.minutes,
      currentY: position.y
    }

    mobileDragSelectionRef.current = nextSelection
    setMobileDragSelection(nextSelection)
  }

  function finishMobileLongPressCreate(e) {
    const selection = mobileDragSelectionRef.current
    const startState = mobileDragStartRef.current

    if (!selection) {
      resetMobileDragCreate()
      return
    }

    e.preventDefault()
    const range = eventRangeFromSelection(selection.anchorMinutes, selection.currentMinutes)
    setMobilePendingEvent({
      date: selectedMobileDate,
      startTime: minutesToTime(range.startMinutes),
      endTime: minutesToTime(range.endMinutes)
    })
    setMobilePendingTitle('')
    if (startState?.timeline.hasPointerCapture?.(startState.pointerId)) {
      startState.timeline.releasePointerCapture(startState.pointerId)
    }
    resetMobileDragCreate()
  }

  function saveMobilePendingEvent(e) {
    e.preventDefault()
    const title = mobilePendingTitle.trim()
    if (!title || !mobilePendingEvent) return

    saveEvent({
      id: null,
      ...mobilePendingEvent,
      title
    })
    setMobilePendingEvent(null)
    setMobilePendingTitle('')
  }

  function isEventInProgress(event) {
    if (event.date !== currentDateISO) return false

    const startMinutes = minutesFromTime(event.startTime)
    const endMinutes = minutesFromTime(event.endTime)
    return currentMinutes >= startMinutes && currentMinutes < endMinutes
  }

  function createDashboardText(dateISO = selectedDashboardDate) {
    const dateLabel = dateFromISO(dateISO).toLocaleDateString('ja-JP', {
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    })
    const dateEvents = events
      .filter(item => item.date === dateISO)
      .map(normalizePlannerEvent)
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
    const dateTasks = sortTasksByOrder(tasks.filter(item => item.date === dateISO))
    const dateMemo = memos[dashboardMemoStorageKey(dateISO)] || ''
    const eventLines = dateEvents.length
      ? dateEvents.map(event => `・${event.startTime}〜${event.endTime} ${event.title || '無題の予定'}`)
      : ['・この日の予定はありません']
    const taskLines = dateTasks.length
      ? dateTasks.map(task => `${task.completed ? '☑' : '□'} ${task.title}`)
      : ['□ この日のタスクはありません']

    const lines = [
      `${dateLabel}の予定`,
      '',
      '【予定】',
      ...eventLines,
      '',
      '【タスク】',
      ...taskLines
    ]

    if (dateMemo.trim()) {
      lines.push('', '【メモ】', dateMemo.trim())
    }

    return lines.join('\n')
  }

  async function copyDashboardText() {
    const text = createDashboardText(selectedDashboardDate)

    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text)
      } else {
        const textarea = document.createElement('textarea')
        textarea.value = text
        textarea.setAttribute('readonly', '')
        textarea.style.position = 'fixed'
        textarea.style.left = '-9999px'
        document.body.appendChild(textarea)
        textarea.select()
        document.execCommand('copy')
        document.body.removeChild(textarea)
      }
      setDashboardCopyMessage('LINE用テキストをコピーしました')
    } catch (error) {
      console.error('Dashboard text copy failed', error)
      setDashboardCopyMessage('コピーに失敗しました')
    }
  }

  return (
    <div className="app-root">
      <header className="app-header">
        <div className="app-title-area">
          <h1>週間プランナー</h1>
          <div className="view-switch" aria-label="画面切り替え">
            <button
              type="button"
              className={currentView === 'planner' ? 'active' : ''}
              onClick={() => setCurrentView('planner')}
            >
              プランナー
            </button>
            <button
              type="button"
              className={currentView === 'dashboard' ? 'active' : ''}
              onClick={() => setCurrentView('dashboard')}
            >
              ダッシュボード
            </button>
            <button
              type="button"
              className={currentView === 'month' ? 'active' : ''}
              onClick={() => setCurrentView('month')}
            >
              月表示
            </button>
          </div>
        </div>
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
            ) : googleStatus === 'reauth' ? (
              <button
                type="button"
                onClick={reauthenticateGoogleCalendar}
                disabled={!googleConfigured || googleStatus === 'loading' || isSyncing}
              >
                Google再認証
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

      <main className="mobile-view" aria-label="スマホ専用表示">
        <section className="mobile-top-card">
          <div className="mobile-date">
            <span>今日</span>
            <strong>{selectedMobileDateLabel}</strong>
          </div>
          <nav className="mobile-tabs" aria-label="スマホ表示切り替え">
            <button
              type="button"
              className={mobileActivePage === 'events' ? 'active' : ''}
              onClick={() => setMobileActivePage('events')}
            >
              予定
            </button>
            <button
              type="button"
              className={mobileActivePage === 'tasks' ? 'active' : ''}
              onClick={() => setMobileActivePage('tasks')}
            >
              タスク
            </button>
            <button
              type="button"
              className={mobileActivePage === 'month' ? 'active' : ''}
              onClick={() => setMobileActivePage('month')}
            >
              月表示
            </button>
            <button
              type="button"
              className={mobileActivePage === 'memo' ? 'active' : ''}
              onClick={() => setMobileActivePage('memo')}
            >
              メモ
            </button>
          </nav>
        </section>

        {mobileActivePage === 'events' && (
          <section className="mobile-section mobile-schedule-page">
            <div className="mobile-section-heading">
              <h2>予定</h2>
              <span>5:00〜24:00</span>
            </div>
            <form className="mobile-add-form mobile-event-form" onSubmit={addMobileEvent}>
              <input
                type="text"
                placeholder="予定タイトル"
                value={mobileEventDraft.title}
                onChange={e => setMobileEventDraft(prev => ({ ...prev, title: e.target.value }))}
              />
              <div className="mobile-time-row">
                <select
                  value={mobileEventDraft.startTime}
                  onChange={e => updateMobileEventStart(e.target.value)}
                >
                  {START_TIME_OPTIONS.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
                <span>〜</span>
                <select
                  value={mobileEventDraft.endTime}
                  onChange={e => setMobileEventDraft(prev => ({ ...prev, endTime: e.target.value }))}
                >
                  {mobileEventEndOptions.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
                <button type="submit">追加</button>
              </div>
            </form>

            {mobilePendingEvent && (
              <form className="mobile-pending-event-form" onSubmit={saveMobilePendingEvent}>
                <span>{mobilePendingEvent.startTime}〜{mobilePendingEvent.endTime}</span>
                <input
                  type="text"
                  placeholder="予定タイトル"
                  value={mobilePendingTitle}
                  onChange={e => setMobilePendingTitle(e.target.value)}
                />
                <div>
                  <button type="submit">保存</button>
                  <button
                    type="button"
                    className="ghost"
                    onClick={() => {
                      setMobilePendingEvent(null)
                      setMobilePendingTitle('')
                    }}
                  >
                    キャンセル
                  </button>
                </div>
              </form>
            )}

            <div
              className={`mobile-timeline ${mobileDragSelection ? 'creating' : ''}`}
              onPointerDown={startMobileLongPressCreate}
              onPointerMove={moveMobileLongPressCreate}
              onPointerUp={finishMobileLongPressCreate}
              onPointerCancel={resetMobileDragCreate}
            >
              {mobileDragSelection && mobileDragRange && (
                <div className="mobile-drag-selection" style={mobileDragPreviewStyle} aria-hidden="true">
                  <span>{minutesToTime(mobileDragRange.startMinutes)}〜{minutesToTime(mobileDragRange.endMinutes)}</span>
                </div>
              )}
              {HOURS.map(hour => {
                const hourStart = hour * 60
                const hourEnd = hour === 24 ? GRID_END_MINUTES + STEP_MINUTES : (hour + 1) * 60
                const hourEvents = selectedMobileEvents.filter(event => {
                  const startMinutes = minutesFromTime(event.startTime)
                  return startMinutes >= hourStart && startMinutes < hourEnd
                })

                return (
                  <div key={hour} className="mobile-hour-row" data-hour={hour}>
                    {hour === currentHour && currentMinutes >= GRID_START_MINUTES && currentMinutes < GRID_END_MINUTES && (
                      <div
                        className="mobile-current-time-line"
                        style={{ top: `${((currentMinutes - hourStart) / 60) * 100}%` }}
                        aria-hidden="true"
                      />
                    )}
                    <div className="mobile-hour-label">
                      {hour === 24 ? '24:00' : `${String(hour).padStart(2, '0')}:00`}
                    </div>
                    <div className="mobile-hour-events">
                      {hourEvents.map(event => (
                        <button
                          key={event.id}
                          type="button"
                          className={`mobile-event-card ${isEventInProgress(event) ? 'current-event' : ''}`}
                          onClick={() => openEdit(event)}
                        >
                          <span className="mobile-event-time">{event.startTime}〜{event.endTime}</span>
                          <span className="mobile-event-title">{event.title || '無題の予定'}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        )}

        {mobileActivePage === 'tasks' && (
          <section className="mobile-section mobile-task-section">
            <div className="mobile-section-heading">
              <h2>タスク</h2>
              <span>{selectedMobileTasks.length}件</span>
            </div>
            <form className="mobile-add-form mobile-task-form" onSubmit={addMobileTask}>
              <input
                type="text"
                placeholder="タスクタイトル"
                value={mobileTaskDraft}
                onChange={e => setMobileTaskDraft(e.target.value)}
              />
              <button type="submit">追加</button>
            </form>
            {selectedMobileTasks.length === 0 ? (
              <p className="mobile-empty">この日のタスクはありません</p>
            ) : (
              <ul className="mobile-task-list">
                {selectedMobileTasks.map(task => (
                  <li key={task.id} className={`mobile-task-item ${task.completed ? 'completed' : ''}`}>
                    <label>
                      <input
                        type="checkbox"
                        checked={task.completed}
                        onChange={() => toggleTask(task.id)}
                      />
                      <span>{task.title}</span>
                    </label>
                    <button type="button" onClick={() => deleteTask(task.id)}>削除</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}

        {mobileActivePage === 'month' && (
          <section className="mobile-section mobile-month-page">
            <div className="mobile-month-header">
              <button type="button" onClick={() => changeMonthView(-1)} aria-label="前月">&lt;</button>
              <strong>{monthViewTitle}</strong>
              <button type="button" onClick={() => changeMonthView(1)} aria-label="翌月">&gt;</button>
            </div>
            <div className="mobile-month-weekdays" aria-hidden="true">
              {['日', '月', '火', '水', '木', '金', '土'].map(day => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="mobile-month-grid">
              {monthCalendarCells.map((dateISO, index) => {
                if (!dateISO) {
                  return <div className="mobile-month-day empty" key={`mobile-month-empty-${index}`} aria-hidden="true" />
                }

                const date = dateFromISO(dateISO)
                const weekendClass = dayHeaderTone(date)
                const isToday = dateISO === currentDateISO
                const isSelected = dateISO === selectedMonthDate
                const dayEvents = eventsFor(dateISO)
                const hasEvents = dayEvents.length > 0

                return (
                  <button
                    type="button"
                    key={dateISO}
                    className={`mobile-month-day ${weekendClass} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => selectMonthDate(dateISO)}
                  >
                    <span className="mobile-month-date">{date.getDate()}</span>
                    {hasEvents && <span className="mobile-month-dot" aria-label="予定あり" />}
                  </button>
                )
              })}
            </div>
            <div className="mobile-month-detail">
              <h3>{selectedMonthDateLabel}</h3>
              <div className="mobile-month-detail-title">予定</div>
              {selectedMonthEvents.length === 0 ? (
                <p className="mobile-empty">この日の予定はありません</p>
              ) : (
                <ul className="mobile-month-event-list">
                  {selectedMonthEvents.map(event => (
                    <li key={event.id} className={`mobile-month-detail-event ${isEventInProgress(event) ? 'current-event' : ''}`}>
                      <span className="mobile-month-detail-time">{event.startTime}〜{event.endTime}</span>
                      <span className="mobile-month-detail-name">{event.title || '無題の予定'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {mobileActivePage === 'memo' && (
          <section className="mobile-section mobile-memo-page">
            <div className="mobile-section-heading">
              <h2>メモ</h2>
              <span>今日のメモ</span>
            </div>
            <textarea
              value={mobileMemoText}
              onChange={e => updateMobileMemo(e.target.value)}
              placeholder="今日のメモを書く..."
            />
          </section>
        )}
      </main>

      {currentView === 'planner' ? (
      <main className="planner-grid">
        <aside className="memo-panel">
          <div
            className={`undated-tasks-panel ${draggedTaskId ? 'drop-ready' : ''}`}
            onDragOver={allowTaskDrop}
            onDrop={e => moveTaskToDate(e, UNDATED_TASK_DATE)}
          >
            <div className="tasks-label">無制限タスク</div>
            <div className="tasks-list">
              {undatedTasks().length === 0 && <div className="no-tasks">タスクなし</div>}
              {undatedTasks().map(task => (
                <div
                  key={task.id}
                  className={`task-item ${task.completed ? 'completed' : ''} ${draggedTaskId === task.id ? 'dragging' : ''} ${dragOverTaskId === task.id && draggedTaskId !== task.id ? 'drag-over' : ''}`}
                  draggable
                  data-task-id={task.id}
                  onPointerDown={e => primeTaskMove(e, task.id)}
                  onDragStart={e => startTaskDrag(e, task.id)}
                  onDragOver={e => markTaskDragOver(e, task.id)}
                  onDragLeave={() => setDragOverTaskId(null)}
                  onDrop={e => moveTaskBeforeTask(e, task.id, UNDATED_TASK_DATE)}
                  onDragEnd={clearActiveDraggedTask}
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
              <div
                className={`task-drop-end ${dragOverTaskEndDate === UNDATED_TASK_DATE ? 'drag-over' : ''}`}
                onDragOver={e => markTaskEndDragOver(e, UNDATED_TASK_DATE)}
                onDragLeave={() => setDragOverTaskEndDate(null)}
                onDrop={e => moveTaskToDate(e, UNDATED_TASK_DATE)}
                aria-hidden="true"
              />
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
                    const isToday = iso === currentDateISO
                    const isDragActive = dragSelection?.date === iso
                    const dragRange = isDragActive
                      ? eventRangeFromSelection(dragSelection.anchorMinutes, dragSelection.currentMinutes)
                      : null
                    return (
                      <div className={`day-column ${tone}`} key={iso}>
                        <div className={`day-header ${tone} ${isToday ? 'today' : ''}`}>
                          <span className="day-name">{day.toLocaleDateString('ja-JP', { weekday: 'short' })}</span>
                          <strong className="day-number">{day.getDate()}</strong>
                        </div>
                        <div className="day-body" onPointerDown={e => startCreateDrag(e, iso)}>
                          {HOURS.map(hour => (
                            <div
                              key={hour}
                              className="slot"
                              style={{ height: ROW_HEIGHT + 'px' }}
                            >
                              <span
                                className={`slot-hour-label ${isToday && hour === currentHour ? 'current-hour' : ''}`}
                                aria-hidden="true"
                              >
                                {hour}
                              </span>
                            </div>
                          ))}
                          {isDragActive && (
                            <div
                              className="drag-selection"
                              style={{
                                top: gridTopFromMinutes(dragRange.startMinutes) + 'px',
                                height: gridHeightFromMinutes(dragRange.startMinutes, dragRange.endMinutes) + 'px',
                                '--event-grid-offset': -gridTopFromMinutes(dragRange.startMinutes) + 'px'
                              }}
                            />
                          )}

                          {dayEvents.map((ev, index) => {
                            const previousEvent = dayEvents[index - 1]
                            const startMinutes = minutesFromTime(ev.startTime)
                            const endMinutes = minutesFromTime(ev.endTime)
                            const top = gridTopFromMinutes(startMinutes)
                            const height = gridHeightFromMinutes(startMinutes, endMinutes)
                            const sizeClass = height < 14 ? 'short-event' : height < 24 ? 'compact-event' : ''
                            const connectedClass = previousEvent?.endTime === ev.startTime ? 'connected-top' : ''
                            return (
                              <div
                                key={ev.id}
                                className={`event-block ${ev.source === GOOGLE_EVENT_SOURCE ? 'google-event' : ''} ${isEventInProgress(ev) ? 'current-event' : ''} ${sizeClass} ${connectedClass}`}
                                style={{
                                  top: top + 'px',
                                  height: Math.max(1, height) + 'px',
                                  '--event-grid-offset': -top + 'px'
                                }}
                                onClick={e => { e.stopPropagation(); openEdit(ev) }}
                              >
                                <div className="event-handle top" onPointerDown={e => startEventDrag(e, ev, 'resize-start')} />
                                <div className="event-content" onPointerDown={e => startEventDrag(e, ev, 'move')}>
                                  <div className="ev-title">{ev.title}</div>
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
                                className={`task-item ${task.completed ? 'completed' : ''} ${draggedTaskId === task.id ? 'dragging' : ''} ${dragOverTaskId === task.id && draggedTaskId !== task.id ? 'drag-over' : ''}`}
                                draggable
                                data-task-id={task.id}
                                onPointerDown={e => primeTaskMove(e, task.id)}
                                onDragStart={e => startTaskDrag(e, task.id)}
                                onDragOver={e => markTaskDragOver(e, task.id)}
                                onDragLeave={() => setDragOverTaskId(null)}
                                onDrop={e => moveTaskBeforeTask(e, task.id, iso)}
                                onDragEnd={clearActiveDraggedTask}
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
                            <div
                              className={`task-drop-end ${dragOverTaskEndDate === iso ? 'drag-over' : ''}`}
                              onDragOver={e => markTaskEndDragOver(e, iso)}
                              onDragLeave={() => setDragOverTaskEndDate(null)}
                              onDrop={e => moveTaskToDate(e, iso)}
                              aria-hidden="true"
                            />
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
      ) : currentView === 'dashboard' ? (
      <main className="dashboard-view">
        <section className="dashboard-top">
          <div>
            <span>日別ダッシュボード</span>
            <strong>{selectedDashboardDateLabel}</strong>
          </div>
          <div className="dashboard-actions">
            <div className="dashboard-actions-right">
              <button type="button" onClick={copyDashboardText}>LINE用にコピー</button>
              {dashboardCopyMessage && <p>{dashboardCopyMessage}</p>}
            </div>
          </div>
        </section>

        <section className="dashboard-layout">
          <div className="dashboard-card">
            <div className="mini-calendar-top">
              <div className="mini-calendar-nav">
                <button type="button" onClick={() => changeDashboardMonth(-1)}>&lt;</button>
                <h2>{dashboardMonthLabel}</h2>
                <button type="button" onClick={() => changeDashboardMonth(1)}>&gt;</button>
              </div>
              <button type="button" className="mini-calendar-today" onClick={returnDashboardToToday}>
                今日に戻る
              </button>
            </div>
            <div className="mini-calendar-weekdays">
              {['月', '火', '水', '木', '金', '土', '日'].map(day => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="mini-calendar-grid">
              {dashboardCalendarCells.map((dateISO, index) => {
                const isSelected = dateISO === selectedDashboardDate
                const isToday = dateISO === currentDateISO
                const date = dateISO ? dateFromISO(dateISO) : null
                const dayOfWeek = date?.getDay()
                const weekendClass = dayOfWeek === 0 ? 'sunday' : dayOfWeek === 6 ? 'saturday' : ''

                return dateISO ? (
                  <button
                    type="button"
                    key={dateISO}
                    className={`dashboard-calendar-day ${weekendClass} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
                    onClick={() => selectDashboardDate(dateISO)}
                  >
                    <span>{dateFromISO(dateISO).getDate()}</span>
                  </button>
                ) : (
                  <span className="mini-calendar-empty" key={`empty-${index}`} />
                )
              })}
            </div>
          </div>

          <div className="dashboard-grid">
            <div className="dashboard-card">
              <h2>選択日の予定</h2>
              <form className="dashboard-add-form dashboard-event-form" onSubmit={addDashboardEvent}>
                <input
                  type="text"
                  value={dashboardEventDraft.title}
                  onChange={e => setDashboardEventDraft(prev => ({ ...prev, title: e.target.value }))}
                  placeholder="予定タイトル"
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                />
                <div className="dashboard-time-inputs">
                  <select
                    value={dashboardEventDraft.startTime}
                    onChange={e => updateDashboardEventStart(e.target.value)}
                    aria-label="開始時間"
                  >
                    {START_TIME_OPTIONS.map(slot => (
                      <option key={slot} value={slot}>{slot}</option>
                    ))}
                  </select>
                  <span>〜</span>
                  <select
                    value={dashboardEventDraft.endTime}
                    onChange={e => setDashboardEventDraft(prev => ({ ...prev, endTime: e.target.value }))}
                    aria-label="終了時間"
                  >
                    {dashboardEventEndOptions.map(slot => (
                      <option key={slot} value={slot}>{slot}</option>
                    ))}
                  </select>
                </div>
                <button type="submit">追加</button>
              </form>
              {selectedDashboardEvents.length === 0 ? (
                <p className="dashboard-empty">この日の予定はありません</p>
              ) : (
                <ul className="dashboard-list event-list">
                  {selectedDashboardEvents.map(event => (
                    <li key={event.id} className={`dashboard-event ${isEventInProgress(event) ? 'current-event' : ''}`}>
                      <span className="dashboard-event-time">{event.startTime}〜{event.endTime}</span>
                      <span>{event.title || '無題の予定'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div
              className="dashboard-card dashboard-tasks-card"
              onDragEnter={allowTaskDrop}
              onDragOver={allowTaskDrop}
              onDrop={e => moveTaskToDate(e, selectedDashboardDate)}
              onPointerUp={e => dropPrimedTaskToDate(e, selectedDashboardDate)}
            >
              <h2>選択日のタスク</h2>
              <div
                className={`dashboard-task-section dashboard-task-dropzone ${canDropTaskToSelectedDate ? 'drag-over' : ''}`}
                onDragOver={allowTaskDrop}
                onDrop={e => moveTaskToDate(e, selectedDashboardDate)}
                onPointerUp={e => dropPrimedTaskToDate(e, selectedDashboardDate)}
              >
                {canDropTaskToSelectedDate && (
                  <p className="dashboard-drop-hint">ここにドロップしてこの日のタスクにする</p>
                )}
                <form className="dashboard-add-form dashboard-task-form" onSubmit={addDashboardTask}>
                  <input
                    type="text"
                    value={dashboardTaskDraft}
                    onChange={e => setDashboardTaskDraft(e.target.value)}
                    placeholder="タスクタイトル"
                    autoCorrect="off"
                    autoCapitalize="off"
                    spellCheck={false}
                  />
                  <button type="submit">追加</button>
                </form>
                {selectedDashboardTasks.length === 0 ? (
                  <p className="dashboard-empty">この日のタスクはありません</p>
                ) : (
                  <ul className="dashboard-list task-list dashboard-task-list">
                    {selectedDashboardTasks.map(task => (
                      <li
                        key={task.id}
                        className={`dashboard-task-row ${task.completed ? 'completed' : ''} ${draggedTaskId === task.id ? 'dragging' : ''} ${dragOverTaskId === task.id && draggedTaskId !== task.id ? 'drag-over' : ''}`}
                        draggable
                        data-task-id={task.id}
                        onPointerDown={e => primeTaskMove(e, task.id)}
                        onDragStart={e => startTaskDrag(e, task.id)}
                        onDragOver={e => markTaskDragOver(e, task.id)}
                        onDragLeave={() => setDragOverTaskId(null)}
                        onDrop={e => moveTaskBeforeTask(e, task.id, selectedDashboardDate)}
                        onDragEnd={clearActiveDraggedTask}
                      >
                        <label draggable onDragStart={e => startTaskDrag(e, task.id)}>
                          <input
                            type="checkbox"
                            checked={task.completed}
                            onChange={() => toggleTask(task.id)}
                          />
                          <span className="dashboard-task-title">{task.title}</span>
                        </label>
                        <button
                          type="button"
                          className="task-delete dashboard-task-delete"
                          draggable={false}
                          onClick={() => deleteTask(task.id)}
                          aria-label={`${task.title}を削除`}
                        >
                          ×
                        </button>
                      </li>
                    ))}
                    <li
                      className={`task-drop-end dashboard-task-drop-end ${dragOverTaskEndDate === selectedDashboardDate ? 'drag-over' : ''}`}
                      onDragOver={e => markTaskEndDragOver(e, selectedDashboardDate)}
                      onDragLeave={() => setDragOverTaskEndDate(null)}
                      onDrop={e => moveTaskToDate(e, selectedDashboardDate)}
                      aria-hidden="true"
                    />
                  </ul>
                )}
              </div>
            </div>

            <div className="dashboard-card dashboard-memo-card">
              <h2>選択日のメモ</h2>
              <textarea
                value={dashboardMemoText}
                onChange={e => updateDashboardMemo(e.target.value)}
                placeholder="この日のメモを書く..."
              />
            </div>
          </div>
        </section>
      </main>
      ) : (
      <main className="month-view">
        <aside className="month-sidebar">
          <button type="button" className="month-today-button" onClick={returnMonthViewToToday}>
            今日に戻る
          </button>
          <div className="month-sidebar-date">
            <span>選択中</span>
            <strong>{selectedMonthDateLabel}</strong>
          </div>
          <div className="month-mini-calendar" aria-label="月表示ミニカレンダー">
            <div className="month-mini-header">
              <button type="button" onClick={() => changeMonthView(-1)} aria-label="前月へ">
                &lt;
              </button>
              <div className="month-mini-title">{monthViewTitle}</div>
              <button type="button" onClick={() => changeMonthView(1)} aria-label="翌月へ">
                &gt;
              </button>
            </div>
            <div className="month-mini-weekdays">
              {['日', '月', '火', '水', '木', '金', '土'].map(day => (
                <span key={day}>{day}</span>
              ))}
            </div>
            <div className="month-mini-grid">
              {monthCalendarCells.map((dateISO, index) => {
                if (!dateISO) {
                  return <span className="month-mini-empty" key={`month-mini-empty-${index}`} />
                }

                const isToday = dateISO === currentDateISO
                const isSelected = dateISO === selectedMonthDate
                const date = dateFromISO(dateISO)
                const dayOfWeek = date.getDay()
                const weekendClass = dayOfWeek === 0 ? 'sunday' : dayOfWeek === 6 ? 'saturday' : ''

                return (
                  <button
                    type="button"
                    key={dateISO}
                    className={`${weekendClass} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => selectMonthDate(dateISO)}
                  >
                    {date.getDate()}
                  </button>
                )
              })}
            </div>
          </div>
          <div className="month-sidebar-events">
            <h3>{selectedMonthDateShortLabel}の予定</h3>
            <form className="month-sidebar-event-form" onSubmit={addMonthEvent}>
              <input
                type="text"
                value={monthEventDraft.title}
                onChange={e => setMonthEventDraft(prev => ({ ...prev, title: e.target.value }))}
                placeholder="予定タイトル"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <div className="month-sidebar-event-time-row">
                <select
                  value={monthEventDraft.startTime}
                  onChange={e => updateMonthEventStart(e.target.value)}
                  aria-label="開始時間"
                >
                  {START_TIME_OPTIONS.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
                <span>〜</span>
                <select
                  value={monthEventDraft.endTime}
                  onChange={e => setMonthEventDraft(prev => ({ ...prev, endTime: e.target.value }))}
                  aria-label="終了時間"
                >
                  {monthEventEndOptions.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
                <button type="submit">追加</button>
              </div>
            </form>
            {selectedMonthEvents.length === 0 ? (
              <p className="month-sidebar-empty">この日の予定はありません</p>
            ) : (
              <ul className="month-sidebar-event-list">
                {selectedMonthEvents.map(event => (
                  <li key={event.id} className={`month-sidebar-event ${isEventInProgress(event) ? 'current-event' : ''}`}>
                    <span className="month-sidebar-event-time">{event.startTime}〜{event.endTime}</span>
                    <span className="month-sidebar-event-title">{event.title || '無題の予定'}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </aside>

        <div className="month-main">
          <section className="month-calendar" aria-label="月表示カレンダー">
            <div className="month-toolbar">
              <div className="month-nav" aria-label="月移動">
                <button type="button" onClick={() => changeMonthView(-1)}>&lt;</button>
                <button type="button" onClick={() => changeMonthView(1)}>&gt;</button>
              </div>
              <h2>{monthViewTitle}</h2>
            </div>

            <div className="month-weekdays">
              {['日', '月', '火', '水', '木', '金', '土'].map(day => (
                <span key={day}>{day}</span>
              ))}
            </div>

            <div className="month-grid">
              {monthCalendarCells.map((dateISO, index) => {
                if (!dateISO) {
                  return <div className="month-day empty" key={`month-empty-${index}`} aria-hidden="true" />
                }

                const dayEvents = eventsFor(dateISO)
                const isToday = dateISO === currentDateISO
                const isSelected = dateISO === selectedMonthDate
                const date = dateFromISO(dateISO)
                const dayOfWeek = date.getDay()
                const weekendClass = dayOfWeek === 0 ? 'sunday' : dayOfWeek === 6 ? 'saturday' : ''

                return (
                  <div
                    key={dateISO}
                    role="button"
                    tabIndex={0}
                    className={`month-day ${weekendClass} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                    onClick={() => selectMonthDate(dateISO)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        selectMonthDate(dateISO)
                      }
                    }}
                  >
                    <div className="month-date-row">
                      <span className="month-date-number">{date.getDate()}</span>
                    </div>

                    <div className="month-day-events">
                      {dayEvents.map(event => (
                        <span className="month-event-pill" title={event.title || '無題の予定'} key={event.id}>
                          {event.title || '無題の予定'}
                        </span>
                      ))}
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </main>
      )}

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
