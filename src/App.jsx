import { useEffect, useMemo, useRef, useState } from 'react'
import './App.css'

const EVENT_STORAGE_KEY = 'wdp_events_v1'
const TASK_STORAGE_KEY = 'wdp_tasks_v1'
const MEMO_STORAGE_KEY = 'wdp_memos_v1'
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
const SUPABASE_CONFIG = {
  url: import.meta.env.VITE_SUPABASE_URL || '',
  anonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || ''
}
const SUPABASE_SAVE_DEBOUNCE_MS = 650
const SUPABASE_PULL_INTERVAL_MS = 30 * 1000
const SUPABASE_DELETE_CHUNK_SIZE = 50
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

function monthCellsFromMonday(monthDate) {
  const year = monthDate.getFullYear()
  const month = monthDate.getMonth()
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

const PLANNER_START_HOUR = 5
const PLANNER_END_HOUR = 24
const PLANNER_SLOT_HOURS = Array.from(
  { length: PLANNER_END_HOUR - PLANNER_START_HOUR },
  (_, i) => PLANNER_START_HOUR + i
)
const MONDAY_WEEKDAY_LABELS = ['月', '火', '水', '木', '金', '土', '日']
const ROW_HEIGHT = 23 // fallback px per hour
const STEP_MINUTES = 10
const STEPS_PER_HOUR = 60 / STEP_MINUTES
const GRID_START_MINUTES = PLANNER_START_HOUR * 60
const GRID_END_MINUTES = PLANNER_END_HOUR * 60
const MOBILE_HOUR_HEIGHT = 80
const MOBILE_TIMELINE_HOURS = Array.from(
  { length: (GRID_END_MINUTES - GRID_START_MINUTES) / 60 },
  (_, i) => GRID_START_MINUTES / 60 + i
)
const MOBILE_TIMELINE_MARKS = Array.from(
  { length: (GRID_END_MINUTES - GRID_START_MINUTES) / 60 + 1 },
  (_, i) => GRID_START_MINUTES / 60 + i
)
const MOBILE_TIMELINE_HEIGHT = MOBILE_TIMELINE_HOURS.length * MOBILE_HOUR_HEIGHT
const TIME_OPTIONS = Array.from(
  { length: (GRID_END_MINUTES - GRID_START_MINUTES) / STEP_MINUTES + 1 },
  (_, i) => minutesToTime(GRID_START_MINUTES + i * STEP_MINUTES)
)
const START_TIME_OPTIONS = TIME_OPTIONS.slice(0, -1)
const GOOGLE_AUTO_SYNC_INTERVAL_MS = 60 * 1000
const MOBILE_LONG_PRESS_MS = 400
const MOBILE_LONG_PRESS_MOVE_CANCEL_PX = 10
const MOBILE_TASK_LONG_PRESS_MS = 400
const MOBILE_TASK_MOVE_CANCEL_PX = 10

function snapToStep(minutes) {
  return Math.round(minutes / STEP_MINUTES) * STEP_MINUTES
}

function clampGridMinutes(minutes, min = GRID_START_MINUTES, max = GRID_END_MINUTES) {
  return clamp(snapToStep(minutes), min, max)
}

function plannerHourRatioFromMinutes(minutes) {
  return (minutes - GRID_START_MINUTES) / 60
}

function gridTopFromMinutes(minutes, hourHeight = ROW_HEIGHT) {
  return plannerHourRatioFromMinutes(minutes) * hourHeight
}

function gridHeightFromMinutes(startMinutes, endMinutes, hourHeight = ROW_HEIGHT) {
  return ((endMinutes - startMinutes) / 60) * hourHeight
}

function plannerHourHeightFromElement(element) {
  if (!element) return ROW_HEIGHT

  const slot = element.matches?.('.slot') ? element : element.querySelector?.('.slot')
  const measuredSlotHeight = slot?.getBoundingClientRect().height
  if (Number.isFinite(measuredSlotHeight) && measuredSlotHeight > 0) {
    return measuredSlotHeight
  }

  const dayBody = element.matches?.('.day-body') ? element : element.querySelector?.('.day-body')
  const measuredDayBodyHeight = dayBody?.getBoundingClientRect().height / PLANNER_SLOT_HOURS.length
  if (Number.isFinite(measuredDayBodyHeight) && measuredDayBodyHeight > 0) {
    return measuredDayBodyHeight
  }

  const computedHourHeight = Number.parseFloat(
    window.getComputedStyle(element).getPropertyValue('--hour-height')
  )

  return Number.isFinite(computedHourHeight) && computedHourHeight > 0
    ? computedHourHeight
    : ROW_HEIGHT
}

function plannerAvailableHourHeightFromElement(element) {
  if (!element) return ROW_HEIGHT

  const grid = element.querySelector?.('.timetable-grid')
  const dayColumn = element.querySelector?.('.day-column')
  const dayHeader = element.querySelector?.('.day-header')
  const tasksPanel = element.querySelector?.('.tasks-panel')
  const columnHeight = dayColumn?.clientHeight || grid?.clientHeight || 0
  const availableHeight = columnHeight
    - (dayHeader?.getBoundingClientRect().height || 0)
    - (tasksPanel?.getBoundingClientRect().height || 0)
  const hourHeight = availableHeight / PLANNER_SLOT_HOURS.length

  return Number.isFinite(hourHeight) && hourHeight > 0
    ? clamp(hourHeight, 12, 56)
    : plannerHourHeightFromElement(element)
}

function minutesFromPointer(e, element) {
  const rect = element.getBoundingClientRect()
  const y = e.clientY - rect.top + element.scrollTop
  const minutesFromStart = (y / plannerHourHeightFromElement(element)) * 60
  return clampGridMinutes(GRID_START_MINUTES + minutesFromStart)
}

function mobileTimelineYForMinutes(minutes) {
  const clampedMinutes = clamp(minutes, GRID_START_MINUTES, GRID_END_MINUTES)
  return ((clampedMinutes - GRID_START_MINUTES) / 60) * MOBILE_HOUR_HEIGHT
}

function mobileTimelineHeightFromMinutes(startMinutes, endMinutes) {
  const normalizedStart = clamp(startMinutes, GRID_START_MINUTES, GRID_END_MINUTES)
  const normalizedEnd = clamp(endMinutes, normalizedStart, GRID_END_MINUTES)
  return ((normalizedEnd - normalizedStart) / 60) * MOBILE_HOUR_HEIGHT
}

function mobilePointerPosition(e, timeline) {
  const timelineRect = timeline.getBoundingClientRect()
  const y = clamp(e.clientY - timelineRect.top, 0, MOBILE_TIMELINE_HEIGHT)
  const minutesFromStart = (y / MOBILE_HOUR_HEIGHT) * 60
  const minutes = clampGridMinutes(GRID_START_MINUTES + minutesFromStart)

  return {
    minutes,
    y: mobileTimelineYForMinutes(minutes)
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
  const eventWithoutReminders = { ...event }
  delete eventWithoutReminders.reminderOffset
  delete eventWithoutReminders.reminderOffsets
  delete eventWithoutReminders.reminders

  return {
    ...eventWithoutReminders,
    ...normalizeEventTimeRange(event.startTime || '05:00', event.endTime || '06:00')
  }
}

function mobileEventBlockStyle(event) {
  const normalizedEvent = normalizePlannerEvent(event)
  const startMinutes = minutesFromTime(normalizedEvent.startTime)
  const endMinutes = minutesFromTime(normalizedEvent.endTime)

  return {
    top: `${mobileTimelineYForMinutes(startMinutes)}px`,
    height: `${mobileTimelineHeightFromMinutes(startMinutes, endMinutes)}px`
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
      useDefault: false
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

function saveGoogleConnected(connected) {
  if (connected) {
    localStorage.setItem(GOOGLE_CONNECTED_STORAGE_KEY, 'true')
  } else {
    localStorage.removeItem(GOOGLE_CONNECTED_STORAGE_KEY)
  }
}

function isSupabaseConfigured() {
  return Boolean(SUPABASE_CONFIG.url && SUPABASE_CONFIG.anonKey)
}

function supabaseBaseUrl() {
  return SUPABASE_CONFIG.url.replace(/\/+$/, '')
}

function supabaseHeaders(extraHeaders = {}) {
  return {
    apikey: SUPABASE_CONFIG.anonKey,
    Authorization: `Bearer ${SUPABASE_CONFIG.anonKey}`,
    ...extraHeaders
  }
}

async function readSupabaseResponse(response) {
  if (response.status === 204) return null

  const text = await response.text()
  if (!text) return null

  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

async function supabaseRequest(path, options = {}) {
  const { headers = {}, ...requestOptions } = options
  const response = await fetch(`${supabaseBaseUrl()}/rest/v1/${path}`, {
    ...requestOptions,
    headers: supabaseHeaders(headers)
  })

  if (!response.ok) {
    const errorBody = await readSupabaseResponse(response).catch(() => null)
    const message = errorBody?.message
      || errorBody?.error_description
      || errorBody?.hint
      || 'Supabase request failed'
    const error = new Error(message)
    error.status = response.status
    error.statusText = response.statusText
    error.errorBody = errorBody
    throw error
  }

  return readSupabaseResponse(response)
}

async function listSupabaseRows(table) {
  const params = new URLSearchParams({ select: '*' })
  return await supabaseRequest(`${table}?${params.toString()}`, {
    method: 'GET',
    headers: {
      Accept: 'application/json'
    }
  }) || []
}

async function upsertSupabaseRows(table, rows) {
  if (!rows.length) return

  const params = new URLSearchParams({ on_conflict: 'id' })
  await supabaseRequest(`${table}?${params.toString()}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal'
    },
    body: JSON.stringify(rows)
  })
}

function supabaseInFilterValue(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

async function deleteSupabaseRows(table, ids) {
  if (!ids.length) return

  for (let i = 0; i < ids.length; i += SUPABASE_DELETE_CHUNK_SIZE) {
    const chunk = ids.slice(i, i + SUPABASE_DELETE_CHUNK_SIZE)
    const params = new URLSearchParams({
      id: `in.(${chunk.map(supabaseInFilterValue).join(',')})`
    })

    await supabaseRequest(`${table}?${params.toString()}`, {
      method: 'DELETE',
      headers: {
        Prefer: 'return=minimal'
      }
    })
  }
}

function rowsById(rows) {
  const map = new Map()
  rows.forEach(row => {
    if (row?.id) map.set(row.id, row)
  })
  return map
}

async function syncSupabaseRows(table, rows, previousRows = new Map()) {
  const currentIds = new Set(rows.map(row => row.id).filter(Boolean))
  const deletedIds = Array.from(previousRows.keys()).filter(id => !currentIds.has(id))

  await upsertSupabaseRows(table, rows)
  await deleteSupabaseRows(table, deletedIds)

  return rowsById(rows)
}

function normalizedSupabaseDate(value) {
  return value || null
}

function eventToSupabaseRow(event, previousRow = null, timestamp = new Date().toISOString()) {
  const normalizedEvent = normalizePlannerEvent(event)
  const createdAt = normalizedEvent.createdAt
    || previousRow?.createdAt
    || previousRow?.created_at
    || timestamp

  return {
    id: normalizedEvent.id,
    title: normalizedEvent.title || '',
    date: normalizedEvent.date,
    startTime: normalizedEvent.startTime,
    endTime: normalizedEvent.endTime,
    googleEventId: normalizedEvent.googleEventId || null,
    createdAt,
    updatedAt: timestamp
  }
}

function eventsToSupabaseRows(events, previousRows = new Map(), timestamp = new Date().toISOString()) {
  return events
    .filter(event => event.id)
    .map(event => eventToSupabaseRow(event, previousRows.get(event.id), timestamp))
}

function normalizeSupabaseEvent(row) {
  const id = row.id || createLocalId('event')
  const normalizedTimes = normalizeEventTimeRange(
    row.startTime ?? row.start_time ?? row.starttime ?? '05:00',
    row.endTime ?? row.end_time ?? row.endtime ?? '06:00'
  )
  const source = id.startsWith(`${GOOGLE_EVENT_SOURCE}-`) ? GOOGLE_EVENT_SOURCE : undefined

  return {
    id,
    title: row.title || '',
    date: row.date || formatISO(new Date()),
    ...normalizedTimes,
    googleEventId: row.googleEventId ?? row.google_event_id ?? null,
    createdAt: row.createdAt ?? row.created_at ?? '',
    updatedAt: row.updatedAt ?? row.updated_at ?? '',
    ...(source ? { source } : {})
  }
}

function taskToSupabaseRow(task, previousRow = null, timestamp = new Date().toISOString()) {
  const createdAt = task.createdAt
    || previousRow?.createdAt
    || previousRow?.created_at
    || timestamp

  return {
    id: task.id,
    title: task.title || '',
    date: task.date && task.date !== UNDATED_TASK_DATE ? task.date : null,
    completed: Boolean(task.completed),
    order: taskOrderValue(task),
    createdAt,
    updatedAt: timestamp
  }
}

function tasksToSupabaseRows(tasks, previousRows = new Map(), timestamp = new Date().toISOString()) {
  return tasks
    .filter(task => task.id)
    .map(task => taskToSupabaseRow(task, previousRows.get(task.id), timestamp))
}

function normalizeSupabaseTask(row) {
  const task = {
    id: row.id || createLocalId('task'),
    title: row.title || '',
    completed: Boolean(row.completed),
    order: taskOrderValue(row),
    createdAt: row.createdAt ?? row.created_at ?? '',
    updatedAt: row.updatedAt ?? row.updated_at ?? ''
  }

  if (normalizedSupabaseDate(row.date)) {
    task.date = row.date
  }

  return task
}

function memoDateFromKey(key) {
  if (key.startsWith(DASHBOARD_MEMO_PREFIX)) {
    return key.slice(DASHBOARD_MEMO_PREFIX.length) || null
  }

  return null
}

function memoKeyFromSupabaseRow(row) {
  if (row.id === SHARED_MEMO_KEY) return SHARED_MEMO_KEY
  if (row.id?.startsWith(DASHBOARD_MEMO_PREFIX)) return row.id
  if (row.date) return dashboardMemoStorageKey(row.date)
  return row.id || SHARED_MEMO_KEY
}

function memosToSupabaseRows(memos, previousRows = new Map(), timestamp = new Date().toISOString()) {
  return Object.entries(memos)
    .filter(([id]) => Boolean(id))
    .map(([id, content]) => {
      const previousRow = previousRows.get(id)
      const createdAt = previousRow?.createdAt || previousRow?.created_at || timestamp

      return {
        id,
        date: id === SHARED_MEMO_KEY ? null : memoDateFromKey(id),
        content: String(content ?? ''),
        createdAt,
        updatedAt: timestamp
      }
    })
}

function memosFromSupabaseRows(rows) {
  return rows.reduce((nextMemos, row) => {
    const key = memoKeyFromSupabaseRow(row)
    nextMemos[key] = String(row.content ?? '')
    return nextMemos
  }, {})
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function normalizeSupabaseJsonValue(value) {
  if (isPlainObject(value)) return value
  if (typeof value !== 'string') return {}

  try {
    const parsed = JSON.parse(value)
    return isPlainObject(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function plannerSettingsPayload() {
  return {}
}

function settingsToSupabaseRows(settings, previousRows = new Map(), timestamp = new Date().toISOString()) {
  const previousRow = previousRows.get('app')

  return [{
    id: 'app',
    value: plannerSettingsPayload(settings),
    createdAt: previousRow?.createdAt || previousRow?.created_at || timestamp,
    updatedAt: timestamp
  }]
}

function settingsFromSupabaseRows(rows) {
  const row = rows.find(item => item.id === 'app') || rows[0]
  if (!row) return {}

  return normalizeSupabaseJsonValue(row.value ?? row.settings)
}

async function loadPlannerDataFromSupabase() {
  const [eventRows, taskRows, memoRows, settingsRows] = await Promise.all([
    listSupabaseRows('events'),
    listSupabaseRows('tasks'),
    listSupabaseRows('memos'),
    listSupabaseRows('settings')
  ])

  return {
    events: eventRows.map(normalizeSupabaseEvent),
    tasks: normalizeTasks(taskRows.map(normalizeSupabaseTask)),
    memos: memosFromSupabaseRows(memoRows),
    settings: settingsFromSupabaseRows(settingsRows)
  }
}

function plannerDataHasContent(data) {
  return data.events.length > 0
    || data.tasks.length > 0
    || Object.keys(data.memos).length > 0
}

function comparableEvents(events) {
  return events
    .map(event => {
      const normalizedEvent = normalizePlannerEvent(event)
      return {
        id: normalizedEvent.id,
        title: normalizedEvent.title || '',
        date: normalizedEvent.date || '',
        startTime: normalizedEvent.startTime,
        endTime: normalizedEvent.endTime,
        googleEventId: normalizedEvent.googleEventId || null
      }
    })
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

function comparableTasks(tasks) {
  return normalizeTasks(tasks)
    .map(task => ({
      id: task.id,
      title: task.title || '',
      date: task.date && task.date !== UNDATED_TASK_DATE ? task.date : null,
      completed: Boolean(task.completed),
      order: taskOrderValue(task)
    }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

function comparableMemos(memos) {
  return Object.entries(memos)
    .map(([id, content]) => ({ id, content: String(content ?? '') }))
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

function comparableSettings() {
  return {}
}

function plannerDataSignature(data) {
  return JSON.stringify({
    events: comparableEvents(data.events),
    tasks: comparableTasks(data.tasks),
    memos: comparableMemos(data.memos),
    settings: comparableSettings(data.settings)
  })
}

function plannerDataEquals(a, b) {
  return plannerDataSignature(a) === plannerDataSignature(b)
}

function supabaseRowsFromPlannerData(data, previousRows = {}, timestamp = new Date().toISOString()) {
  return {
    events: eventsToSupabaseRows(data.events, previousRows.events, timestamp),
    tasks: tasksToSupabaseRows(data.tasks, previousRows.tasks, timestamp),
    memos: memosToSupabaseRows(data.memos, previousRows.memos, timestamp),
    settings: settingsToSupabaseRows(data.settings, previousRows.settings, timestamp)
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

  function submit(e) {
    e && e.preventDefault()
    if (!title.trim()) return
    const eventData = { ...initial }
    delete eventData.reminderOffset
    delete eventData.reminderOffsets
    delete eventData.reminders
    const normalizedTimes = normalizeEventTimeRange(startTime, endTime)

    onSave({
      ...eventData,
      title,
      date,
      ...normalizedTimes
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
  const supabaseConfigured = isSupabaseConfigured()
  const googleTokenClient = useRef(null)
  const googleAccessTokenRef = useRef('')
  const googleConnectedRef = useRef(googleConfigured && defaultGoogleConnected())
  const eventsRef = useRef([])
  const tasksRef = useRef([])
  const memosRef = useRef({})
  const dragUpdatedEventRef = useRef(null)
  const pendingGoogleInsertIdsRef = useRef(new Set())
  const updateGoogleEventRef = useRef(null)
  const syncCurrentWeekWithGoogleRef = useRef(null)
  const isSyncingRef = useRef(false)
  const initialPlannerDataRef = useRef(null)
  const supabaseReadyRef = useRef(false)
  const applyingSupabaseSnapshotRef = useRef(false)
  const supabaseSaveTimersRef = useRef({ events: null, tasks: null, memos: null, settings: null })
  const supabaseRowsRef = useRef({
    events: new Map(),
    tasks: new Map(),
    memos: new Map(),
    settings: new Map()
  })
  const supabasePushInFlightRef = useRef(0)
  const lastLocalSupabaseChangeAtRef = useRef(0)
  const mobileLongPressTimerRef = useRef(null)
  const mobileDragStartRef = useRef(null)
  const mobileDragSelectionRef = useRef(null)
  const mobileDragModeRef = useRef('idle')
  const mobileDragListenersCleanupRef = useRef(null)
  const mobileDragScrollLockRef = useRef(null)
  const mobileScheduleSectionRef = useRef(null)
  const mobileScheduleAutoScrollKeyRef = useRef('')
  const mobileTaskListRef = useRef(null)
  const mobileTaskLongPressTimerRef = useRef(null)
  const mobileTaskDragStateRef = useRef(null)
  const mobileTaskDragListenersCleanupRef = useRef(null)
  const mobileTaskSuppressClickRef = useRef(false)
  const plannerTimetableRef = useRef(null)
  const [centerDate, setCenterDate] = useState(() => {
    const today = startOfWeek(new Date())
    if (today < MIN_WEEK) return MIN_WEEK
    if (today > MAX_WEEK) return MAX_WEEK
    return today
  })
  const [events, setEvents] = useState(() => defaultEvents())
  const [tasks, setTasks] = useState(() => defaultTasks())
  const [memos, setMemos] = useState(() => defaultMemos())
  if (initialPlannerDataRef.current == null) {
    initialPlannerDataRef.current = { events, tasks, memos }
  }
  const [, setUndoStack] = useState([])
  const [editing, setEditing] = useState(null)
  const [dragSelection, setDragSelection] = useState(null)
  const [dragState, setDragState] = useState(null)
  const [draggedTaskId, setDraggedTaskId] = useState(null)
  const [dragOverTaskId, setDragOverTaskId] = useState(null)
  const [dragOverTaskEndDate, setDragOverTaskEndDate] = useState(null)
  const [plannerHourHeight, setPlannerHourHeight] = useState(ROW_HEIGHT)
  const dragSelectionBodyRef = useRef(null)
  const dragSelectionRef = useRef(null)
  const draggedTaskIdRef = useRef(null)
  const undoStackRef = useRef([])
  const undoActionRef = useRef(null)
  const [now, setNow] = useState(new Date())
  const [taskDrafts, setTaskDrafts] = useState({})
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
  const [cloudStatus, setCloudStatus] = useState(() => (
    supabaseConfigured ? 'loading' : 'missing-config'
  ))
  const [cloudMessage, setCloudMessage] = useState(() => (
    supabaseConfigured ? 'クラウド読込中' : 'クラウド設定待ち'
  ))
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
  const [mobileTaskDraft, setMobileTaskDraft] = useState('')
  const [mobileDragSelection, setMobileDragSelection] = useState(null)
  const [mobileTaskDragState, setMobileTaskDragState] = useState(null)
  const [isMobileDragScrollLocked, setIsMobileDragScrollLocked] = useState(false)
  const [isEventModalOpen, setIsEventModalOpen] = useState(false)
  const [editingEventId, setEditingEventId] = useState(null)
  const [draftEventTitle, setDraftEventTitle] = useState('')
  const [draftEventDate, setDraftEventDate] = useState(() => formatISO(new Date()))
  const [draftEventStart, setDraftEventStart] = useState('09:00')
  const [draftEventEnd, setDraftEventEnd] = useState('10:00')

  useEffect(() => {
    eventsRef.current = events
    saveEvents(events)

    if (!supabaseConfigured || !supabaseReadyRef.current || applyingSupabaseSnapshotRef.current) return

    lastLocalSupabaseChangeAtRef.current = Date.now()
    setCloudStatus('saving')
    setCloudMessage('クラウド保存中')

    if (supabaseSaveTimersRef.current.events) {
      window.clearTimeout(supabaseSaveTimersRef.current.events)
    }

    const snapshot = events
    supabaseSaveTimersRef.current.events = window.setTimeout(() => {
      void (async () => {
        supabasePushInFlightRef.current += 1
        try {
          const timestamp = new Date().toISOString()
          const rows = eventsToSupabaseRows(snapshot, supabaseRowsRef.current.events, timestamp)
          supabaseRowsRef.current.events = await syncSupabaseRows('events', rows, supabaseRowsRef.current.events)
          setCloudStatus('connected')
          setCloudMessage(`クラウド保存済み ${formatClock(new Date())}`)
        } catch (error) {
          console.error('Supabase events sync failed', error)
          setCloudStatus('error')
          setCloudMessage('クラウド保存失敗')
        } finally {
          supabasePushInFlightRef.current -= 1
        }
      })()
    }, SUPABASE_SAVE_DEBOUNCE_MS)
  }, [events, supabaseConfigured])

  useEffect(() => {
    tasksRef.current = tasks
    saveTasks(tasks)

    if (!supabaseConfigured || !supabaseReadyRef.current || applyingSupabaseSnapshotRef.current) return

    lastLocalSupabaseChangeAtRef.current = Date.now()
    setCloudStatus('saving')
    setCloudMessage('クラウド保存中')

    if (supabaseSaveTimersRef.current.tasks) {
      window.clearTimeout(supabaseSaveTimersRef.current.tasks)
    }

    const snapshot = tasks
    supabaseSaveTimersRef.current.tasks = window.setTimeout(() => {
      void (async () => {
        supabasePushInFlightRef.current += 1
        try {
          const timestamp = new Date().toISOString()
          const rows = tasksToSupabaseRows(snapshot, supabaseRowsRef.current.tasks, timestamp)
          supabaseRowsRef.current.tasks = await syncSupabaseRows('tasks', rows, supabaseRowsRef.current.tasks)
          setCloudStatus('connected')
          setCloudMessage(`クラウド保存済み ${formatClock(new Date())}`)
        } catch (error) {
          console.error('Supabase tasks sync failed', error)
          setCloudStatus('error')
          setCloudMessage('クラウド保存失敗')
        } finally {
          supabasePushInFlightRef.current -= 1
        }
      })()
    }, SUPABASE_SAVE_DEBOUNCE_MS)
  }, [tasks, supabaseConfigured])

  useEffect(() => {
    memosRef.current = memos
    saveMemos(memos)

    if (!supabaseConfigured || !supabaseReadyRef.current || applyingSupabaseSnapshotRef.current) return

    lastLocalSupabaseChangeAtRef.current = Date.now()
    setCloudStatus('saving')
    setCloudMessage('クラウド保存中')

    if (supabaseSaveTimersRef.current.memos) {
      window.clearTimeout(supabaseSaveTimersRef.current.memos)
    }

    const snapshot = memos
    supabaseSaveTimersRef.current.memos = window.setTimeout(() => {
      void (async () => {
        supabasePushInFlightRef.current += 1
        try {
          const timestamp = new Date().toISOString()
          const rows = memosToSupabaseRows(snapshot, supabaseRowsRef.current.memos, timestamp)
          supabaseRowsRef.current.memos = await syncSupabaseRows('memos', rows, supabaseRowsRef.current.memos)
          setCloudStatus('connected')
          setCloudMessage(`クラウド保存済み ${formatClock(new Date())}`)
        } catch (error) {
          console.error('Supabase memos sync failed', error)
          setCloudStatus('error')
          setCloudMessage('クラウド保存失敗')
        } finally {
          supabasePushInFlightRef.current -= 1
        }
      })()
    }, SUPABASE_SAVE_DEBOUNCE_MS)
  }, [memos, supabaseConfigured])

  useEffect(() => {
    googleConnectedRef.current = googleConnected
    saveGoogleConnected(googleConnected)
  }, [googleConnected])

  useEffect(() => {
    if (!supabaseConfigured) {
      supabaseReadyRef.current = false
      return undefined
    }

    let cancelled = false

    async function hydrateFromSupabase() {
      try {
        setCloudStatus('loading')
        setCloudMessage('クラウド読込中')
        const remoteData = await loadPlannerDataFromSupabase()
        if (cancelled) return

        const timestamp = new Date().toISOString()
        const remoteRows = supabaseRowsFromPlannerData(remoteData, supabaseRowsRef.current, timestamp)
        supabaseRowsRef.current = {
          events: rowsById(remoteRows.events),
          tasks: rowsById(remoteRows.tasks),
          memos: rowsById(remoteRows.memos),
          settings: rowsById(remoteRows.settings)
        }

        if (plannerDataHasContent(remoteData)) {
          applyingSupabaseSnapshotRef.current = true
          supabaseReadyRef.current = false
          eventsRef.current = remoteData.events
          tasksRef.current = remoteData.tasks
          memosRef.current = remoteData.memos
          setEvents(remoteData.events)
          setTasks(remoteData.tasks)
          setMemos(remoteData.memos)
          setCloudStatus('connected')
          setCloudMessage(`クラウド読込済み ${formatClock(new Date())}`)

          window.setTimeout(() => {
            applyingSupabaseSnapshotRef.current = false
            supabaseReadyRef.current = true
          }, 0)
          return
        }

        const initialLocalData = {
          ...(initialPlannerDataRef.current || { events: [], tasks: [], memos: {} }),
          settings: plannerSettingsPayload()
        }
        if (plannerDataHasContent(initialLocalData)) {
          setCloudStatus('saving')
          setCloudMessage('クラウド初回保存中')
          const localRows = supabaseRowsFromPlannerData(initialLocalData, supabaseRowsRef.current, timestamp)
          supabaseRowsRef.current = {
            events: await syncSupabaseRows('events', localRows.events, supabaseRowsRef.current.events),
            tasks: await syncSupabaseRows('tasks', localRows.tasks, supabaseRowsRef.current.tasks),
            memos: await syncSupabaseRows('memos', localRows.memos, supabaseRowsRef.current.memos),
            settings: await syncSupabaseRows('settings', localRows.settings, supabaseRowsRef.current.settings)
          }
          setCloudStatus('connected')
          setCloudMessage(`クラウド初回保存済み ${formatClock(new Date())}`)
        } else {
          const settingsRows = settingsToSupabaseRows(initialLocalData.settings, supabaseRowsRef.current.settings, timestamp)
          supabaseRowsRef.current.settings = await syncSupabaseRows(
            'settings',
            settingsRows,
            supabaseRowsRef.current.settings
          )
          setCloudStatus('connected')
          setCloudMessage('クラウド保存準備OK')
        }

        supabaseReadyRef.current = true
      } catch (error) {
        applyingSupabaseSnapshotRef.current = false
        supabaseReadyRef.current = false
        console.error('Supabase sync failed', error)
        setCloudStatus('error')
        setCloudMessage('クラウド読込失敗')
      }
    }

    void hydrateFromSupabase()

    return () => {
      cancelled = true
    }
  }, [supabaseConfigured])

  useEffect(() => {
    if (!supabaseConfigured) return undefined

    async function refreshFromSupabase() {
      if (!supabaseReadyRef.current || applyingSupabaseSnapshotRef.current) return
      if (supabasePushInFlightRef.current > 0) return
      if (Date.now() - lastLocalSupabaseChangeAtRef.current < SUPABASE_SAVE_DEBOUNCE_MS + 1000) return

      try {
        const remoteData = await loadPlannerDataFromSupabase()
        const timestamp = new Date().toISOString()
        const remoteRows = supabaseRowsFromPlannerData(remoteData, supabaseRowsRef.current, timestamp)
        const currentData = {
          events: eventsRef.current,
          tasks: tasksRef.current,
          memos: memosRef.current,
          settings: plannerSettingsPayload()
        }

        supabaseRowsRef.current = {
          events: rowsById(remoteRows.events),
          tasks: rowsById(remoteRows.tasks),
          memos: rowsById(remoteRows.memos),
          settings: rowsById(remoteRows.settings)
        }

        if (plannerDataEquals(remoteData, currentData)) return

        applyingSupabaseSnapshotRef.current = true
        supabaseReadyRef.current = false
        eventsRef.current = remoteData.events
        tasksRef.current = remoteData.tasks
        memosRef.current = remoteData.memos
        setEvents(remoteData.events)
        setTasks(remoteData.tasks)
        setMemos(remoteData.memos)
        setCloudStatus('connected')
        setCloudMessage(`クラウド更新 ${formatClock(new Date())}`)

        window.setTimeout(() => {
          applyingSupabaseSnapshotRef.current = false
          supabaseReadyRef.current = true
        }, 0)
      } catch (error) {
        console.error('Supabase refresh failed', error)
        setCloudStatus('error')
        setCloudMessage('クラウド読込失敗')
      }
    }

    const intervalId = window.setInterval(refreshFromSupabase, SUPABASE_PULL_INTERVAL_MS)
    const refreshOnFocus = () => {
      void refreshFromSupabase()
    }
    const refreshOnVisible = () => {
      if (document.visibilityState === 'visible') {
        void refreshFromSupabase()
      }
    }

    window.addEventListener('focus', refreshOnFocus)
    document.addEventListener('visibilitychange', refreshOnVisible)

    return () => {
      window.clearInterval(intervalId)
      window.removeEventListener('focus', refreshOnFocus)
      document.removeEventListener('visibilitychange', refreshOnVisible)
    }
  }, [supabaseConfigured])

  useEffect(() => () => {
    Object.values(supabaseSaveTimersRef.current).forEach(timerId => {
      if (timerId) window.clearTimeout(timerId)
    })
  }, [])

  useEffect(() => {
    if (!isEventModalOpen) return undefined

    const previousBodyOverflow = document.body.style.overflow
    const previousDocumentOverflow = document.documentElement.style.overflow
    document.body.style.overflow = 'hidden'
    document.documentElement.style.overflow = 'hidden'

    return () => {
      document.body.style.overflow = previousBodyOverflow
      document.documentElement.style.overflow = previousDocumentOverflow
    }
  }, [isEventModalOpen])

  useEffect(() => {
    if (!isMobileDragScrollLocked) return undefined

    const scrollX = window.scrollX
    const scrollY = window.scrollY
    const lock = {
      scrollX,
      scrollY,
      bodyPosition: document.body.style.position,
      bodyTop: document.body.style.top,
      bodyLeft: document.body.style.left,
      bodyRight: document.body.style.right,
      bodyWidth: document.body.style.width,
      bodyOverflow: document.body.style.overflow,
      bodyTouchAction: document.body.style.touchAction,
      documentOverflow: document.documentElement.style.overflow,
      documentTouchAction: document.documentElement.style.touchAction
    }

    mobileDragScrollLockRef.current = lock
    document.body.style.position = 'fixed'
    document.body.style.top = `-${scrollY}px`
    document.body.style.left = '0'
    document.body.style.right = '0'
    document.body.style.width = '100%'
    document.body.style.overflow = 'hidden'
    document.body.style.touchAction = 'none'
    document.documentElement.style.overflow = 'hidden'
    document.documentElement.style.touchAction = 'none'

    return () => {
      document.body.style.position = lock.bodyPosition
      document.body.style.top = lock.bodyTop
      document.body.style.left = lock.bodyLeft
      document.body.style.right = lock.bodyRight
      document.body.style.width = lock.bodyWidth
      document.body.style.overflow = lock.bodyOverflow
      document.body.style.touchAction = lock.bodyTouchAction
      document.documentElement.style.overflow = lock.documentOverflow
      document.documentElement.style.touchAction = lock.documentTouchAction
      window.scrollTo(lock.scrollX, lock.scrollY)
      if (mobileDragScrollLockRef.current === lock) {
        mobileDragScrollLockRef.current = null
      }
    }
  }, [isMobileDragScrollLocked])

  useEffect(() => () => {
    if (mobileLongPressTimerRef.current) {
      window.clearTimeout(mobileLongPressTimerRef.current)
    }
    if (mobileTaskLongPressTimerRef.current) {
      window.clearTimeout(mobileTaskLongPressTimerRef.current)
    }
    mobileDragListenersCleanupRef.current?.()
    mobileTaskDragListenersCleanupRef.current?.()
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
    .map(normalizePlannerEvent)
    .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  const selectedMobileTasks = sortTasksByOrder(tasks.filter(item => item.date === selectedMobileDate))
  const mobileMemoText = memoText
  const mobileDragRange = mobileDragSelection
    ? {
        startMinutes: Math.min(mobileDragSelection.anchorMinutes, mobileDragSelection.currentMinutes),
        endMinutes: Math.max(mobileDragSelection.anchorMinutes, mobileDragSelection.currentMinutes)
      }
    : null
  const mobileDragPreviewStyle = mobileDragSelection
    ? {
        top: `${mobileTimelineYForMinutes(mobileDragRange.startMinutes)}px`,
        height: `${Math.max(
          2,
          mobileTimelineHeightFromMinutes(mobileDragRange.startMinutes, mobileDragRange.endMinutes)
        )}px`
      }
    : null
  const draggedTask = useMemo(() => (
    tasks.find(item => item.id === draggedTaskId) || null
  ), [tasks, draggedTaskId])
  const canDropTaskToSelectedDate = Boolean(draggedTask && taskDateKey(draggedTask) !== selectedDashboardDate)
  const dashboardCalendarCells = useMemo(() => (
    monthCellsFromMonday(dashboardCalendarMonth)
  ), [dashboardCalendarMonth])
  const dashboardEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(dashboardEventDraft.startTime))
  ), [dashboardEventDraft.startTime])
  const monthEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(monthEventDraft.startTime))
  ), [monthEventDraft.startTime])
  const draftEventEndOptions = useMemo(() => (
    TIME_OPTIONS.filter(slot => minutesFromTime(slot) > minutesFromTime(draftEventStart))
  ), [draftEventStart])
  const monthViewTitle = monthViewMonth.toLocaleDateString('ja-JP', {
    year: 'numeric',
    month: 'long'
  })
  const monthCalendarCells = useMemo(() => (
    monthCellsFromMonday(monthViewMonth)
  ), [monthViewMonth])
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
      .map(normalizePlannerEvent)
      .sort((a, b) => minutesFromTime(a.startTime) - minutesFromTime(b.startTime))
  ), [events, selectedMonthDate])

  useEffect(() => {
    if (currentView !== 'planner') return undefined
    const timetable = plannerTimetableRef.current
    if (!timetable) return undefined

    const updatePlannerHourHeight = () => {
      const nextHourHeight = plannerAvailableHourHeightFromElement(timetable)
      setPlannerHourHeight(prev => (
        Math.abs(prev - nextHourHeight) < 0.1 ? prev : nextHourHeight
      ))
    }

    updatePlannerHourHeight()
    window.addEventListener('resize', updatePlannerHourHeight)

    let resizeObserver = null
    if ('ResizeObserver' in window) {
      resizeObserver = new window.ResizeObserver(updatePlannerHourHeight)
      resizeObserver.observe(timetable)
    }

    return () => {
      window.removeEventListener('resize', updatePlannerHourHeight)
      resizeObserver?.disconnect()
    }
  }, [currentView])

  useEffect(() => {
    if (mobileActivePage !== 'events') return
    const scheduleSection = mobileScheduleSectionRef.current
    if (!scheduleSection) return

    const scrollKey = currentDateISO
    if (mobileScheduleAutoScrollKeyRef.current === scrollKey) return
    mobileScheduleAutoScrollKeyRef.current = scrollKey

    let firstFrame = 0
    let secondFrame = 0
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        const targetMinutes = clamp(currentMinutes, GRID_START_MINUTES, GRID_END_MINUTES)
        const targetY = mobileTimelineYForMinutes(targetMinutes)
        const visibleOffset = scheduleSection.clientHeight * 0.38
        const maxScrollTop = Math.max(0, scheduleSection.scrollHeight - scheduleSection.clientHeight)
        const nextScrollTop = clamp(targetY - visibleOffset, 0, maxScrollTop)
        scheduleSection.scrollTo({ top: nextScrollTop, behavior: 'auto' })
      })
    })

    return () => {
      window.cancelAnimationFrame(firstFrame)
      window.cancelAnimationFrame(secondFrame)
    }
  }, [currentDateISO, currentMinutes, mobileActivePage])

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
    if (!dragState) return

    function handlePointerMove(e) {
      e.preventDefault()
      setEvents(prev => prev.map(ev => {
        if (ev.id !== dragState.eventId) return ev

        const deltaY = e.clientY - dragState.originY
        const stepPixels = (dragState.hourHeight || ROW_HEIGHT) / STEPS_PER_HOUR
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

  function saveMobileEvent(ev) {
    const normalizedEvent = {
      ...ev,
      ...normalizeEventTimeRange(ev.startTime, ev.endTime)
    }
    const id = createLocalId('event')
    const localEvent = { ...normalizedEvent, id }
    const accessToken = currentGoogleAccessToken()

    saveUndoSnapshot()
    setEvents(prev => [...prev, localEvent])

    if (accessToken && isGoogleSyncConnected()) {
      void addEventToGoogleCalendar(localEvent)
    }
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
      initialEnd: minutesFromTime(ev.endTime),
      hourHeight: plannerHourHeightFromElement(dayBody)
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

  function cleanupMobileTaskDrag() {
    if (mobileTaskLongPressTimerRef.current) {
      window.clearTimeout(mobileTaskLongPressTimerRef.current)
      mobileTaskLongPressTimerRef.current = null
    }
    mobileTaskDragListenersCleanupRef.current?.()
    mobileTaskDragListenersCleanupRef.current = null
    mobileTaskDragStateRef.current = null
    setMobileTaskDragState(null)
  }

  function mobileTaskBeforeIdFromPointer(clientY, draggedTaskId) {
    const list = mobileTaskListRef.current
    if (!list) return null

    const taskItems = Array.from(list.querySelectorAll('[data-mobile-task-id]'))
      .filter(item => item.dataset.mobileTaskId !== draggedTaskId)

    for (const item of taskItems) {
      const rect = item.getBoundingClientRect()
      if (clientY < rect.top + rect.height / 2) {
        return item.dataset.mobileTaskId || null
      }
    }

    return null
  }

  function reorderMobileTask(taskId, dateISO, beforeTaskId) {
    const currentTasks = tasksRef.current
    const result = moveTaskInList(currentTasks, taskId, dateISO, beforeTaskId)
    if (!result.changed) return

    saveUndoSnapshot()
    setTasks(result.tasks)
  }

  function startMobileTaskReorder(e, taskId) {
    if (e.button !== undefined && e.button !== 0) return
    if (e.target.closest('button, input')) return

    const startState = {
      taskId,
      dateISO: selectedMobileDate,
      pointerId: e.pointerId,
      startY: e.clientY,
      currentY: e.clientY,
      beforeTaskId: taskId,
      dragging: false
    }

    cleanupMobileTaskDrag()
    mobileTaskDragStateRef.current = startState

    const activateDrag = () => {
      const activeState = mobileTaskDragStateRef.current
      if (!activeState) return

      const nextState = {
        ...activeState,
        dragging: true,
        beforeTaskId: mobileTaskBeforeIdFromPointer(activeState.currentY, taskId)
      }
      mobileTaskDragStateRef.current = nextState
      setMobileTaskDragState(nextState)
    }

    function handlePointerMove(moveEvent) {
      const state = mobileTaskDragStateRef.current
      if (!state || moveEvent.pointerId !== state.pointerId) return

      const deltaY = moveEvent.clientY - state.startY
      if (!state.dragging) {
        if (Math.abs(deltaY) > MOBILE_TASK_MOVE_CANCEL_PX) {
          cleanupMobileTaskDrag()
        }
        return
      }

      moveEvent.preventDefault()
      const beforeTaskId = mobileTaskBeforeIdFromPointer(moveEvent.clientY, state.taskId)
      const nextState = {
        ...state,
        currentY: moveEvent.clientY,
        beforeTaskId
      }
      mobileTaskDragStateRef.current = nextState
      setMobileTaskDragState(nextState)
    }

    function handlePointerUp(upEvent) {
      const state = mobileTaskDragStateRef.current
      if (!state || upEvent.pointerId !== state.pointerId) return

      if (state.dragging) {
        upEvent.preventDefault()
        const beforeTaskId = mobileTaskBeforeIdFromPointer(upEvent.clientY, state.taskId)
        reorderMobileTask(state.taskId, state.dateISO, beforeTaskId)
        mobileTaskSuppressClickRef.current = true
        window.setTimeout(() => {
          mobileTaskSuppressClickRef.current = false
        }, 0)
      }

      cleanupMobileTaskDrag()
    }

    function handlePointerCancel(cancelEvent) {
      const state = mobileTaskDragStateRef.current
      if (!state || cancelEvent.pointerId !== state.pointerId) return
      cleanupMobileTaskDrag()
    }

    window.addEventListener('pointermove', handlePointerMove, { passive: false })
    window.addEventListener('pointerup', handlePointerUp, { passive: false })
    window.addEventListener('pointercancel', handlePointerCancel)
    mobileTaskDragListenersCleanupRef.current = () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerCancel)
    }

    mobileTaskLongPressTimerRef.current = window.setTimeout(activateDrag, MOBILE_TASK_LONG_PRESS_MS)
  }

  function suppressMobileTaskClickAfterDrag(e) {
    if (!mobileTaskSuppressClickRef.current) return
    e.preventDefault()
    e.stopPropagation()
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

  function openMobileEventModal(event) {
    const normalizedEvent = normalizePlannerEvent(event)
    setEditingEventId(normalizedEvent.id || null)
    setDraftEventTitle(normalizedEvent.title || '')
    setDraftEventDate(normalizedEvent.date || selectedMobileDate)
    setDraftEventStart(normalizedEvent.startTime)
    setDraftEventEnd(normalizedEvent.endTime)
    setIsEventModalOpen(true)
  }

  function openMobileNewEventModal({ date = selectedMobileDate, startTime = '09:00', endTime = '10:00' } = {}) {
    const normalizedTimes = normalizeEventTimeRange(startTime, endTime)
    setEditingEventId(null)
    setDraftEventTitle('')
    setDraftEventDate(date)
    setDraftEventStart(normalizedTimes.startTime)
    setDraftEventEnd(normalizedTimes.endTime)
    setIsEventModalOpen(true)
  }

  function closeMobileEventModal() {
    setIsEventModalOpen(false)
    setEditingEventId(null)
    resetMobileDragCreate()
  }

  function updateDraftEventStart(startTime) {
    setDraftEventStart(startTime)
    setDraftEventEnd(prev => {
      const startMinutes = minutesFromTime(startTime)
      const endMinutes = minutesFromTime(prev)
      return endMinutes > startMinutes
        ? prev
        : minutesToTime(Math.min(startMinutes + STEP_MINUTES, GRID_END_MINUTES))
    })
  }

  function saveMobileEventModal(e) {
    e.preventDefault()
    const title = draftEventTitle.trim() || '無題の予定'
    const normalizedTimes = normalizeEventTimeRange(draftEventStart, draftEventEnd)
    const eventData = {
      title,
      date: draftEventDate,
      ...normalizedTimes
    }

    if (editingEventId) {
      const existingEvent = eventsRef.current.find(item => item.id === editingEventId)
      if (!existingEvent) {
        closeMobileEventModal()
        return
      }

      saveEvent({
        ...existingEvent,
        ...eventData
      })
    } else {
      saveMobileEvent(eventData)
    }

    closeMobileEventModal()
  }

  function deleteMobileEventModal() {
    if (!editingEventId) return
    deleteEvent(editingEventId)
    closeMobileEventModal()
  }

  function clearMobileLongPressTimer() {
    if (!mobileLongPressTimerRef.current) return
    window.clearTimeout(mobileLongPressTimerRef.current)
    mobileLongPressTimerRef.current = null
  }

  function clearMobileDragDocumentListeners() {
    mobileDragListenersCleanupRef.current?.()
    mobileDragListenersCleanupRef.current = null
  }

  function preventMobileGestureDefault(e) {
    if (e?.cancelable === false) return
    e?.preventDefault?.()
  }

  function pointFromMobileGestureEvent(e) {
    if (!e) return null
    if (Number.isFinite(e.clientY)) {
      return { clientX: e.clientX, clientY: e.clientY }
    }

    const touch = e.touches?.[0] || e.changedTouches?.[0]
    if (!touch) return null

    return { clientX: touch.clientX, clientY: touch.clientY }
  }

  function isMatchingMobileDragPointer(e, startState = mobileDragStartRef.current) {
    if (!startState) return false
    if (e?.pointerId == null) return true
    return e.pointerId === startState.pointerId
  }

  function lockMobileDragScroll() {
    setIsMobileDragScrollLocked(true)
  }

  function unlockMobileDragScroll() {
    setIsMobileDragScrollLocked(false)
  }

  function releaseMobilePointerCapture(startState) {
    if (!startState?.timeline?.hasPointerCapture?.(startState.pointerId)) return

    try {
      startState.timeline.releasePointerCapture(startState.pointerId)
    } catch {
      // Pointer capture may already be released by the browser after cancellation.
    }
  }

  function bindMobileDragDocumentListeners() {
    clearMobileDragDocumentListeners()

    const handlePointerMove = event => {
      updateMobileDragCreate(event)
    }
    const handlePointerUp = event => {
      finishMobileLongPressCreate(event)
    }
    const handlePointerCancel = event => {
      cancelMobileLongPressCreate(event)
    }
    const handleTouchMove = event => {
      if (mobileDragModeRef.current !== 'creating') return
      preventMobileGestureDefault(event)
      updateMobileDragCreate(event)
    }
    const handleTouchEnd = event => {
      if (mobileDragModeRef.current === 'creating') {
        finishMobileLongPressCreate(event)
        return
      }
      if (mobileDragModeRef.current === 'pressing') {
        resetMobileDragCreate()
      }
    }
    const handleTouchCancel = event => {
      cancelMobileLongPressCreate(event)
    }

    document.addEventListener('pointermove', handlePointerMove, true)
    document.addEventListener('pointerup', handlePointerUp, true)
    document.addEventListener('pointercancel', handlePointerCancel, true)
    document.addEventListener('touchmove', handleTouchMove, { capture: true, passive: false })
    document.addEventListener('touchend', handleTouchEnd, true)
    document.addEventListener('touchcancel', handleTouchCancel, true)

    mobileDragListenersCleanupRef.current = () => {
      document.removeEventListener('pointermove', handlePointerMove, true)
      document.removeEventListener('pointerup', handlePointerUp, true)
      document.removeEventListener('pointercancel', handlePointerCancel, true)
      document.removeEventListener('touchmove', handleTouchMove, true)
      document.removeEventListener('touchend', handleTouchEnd, true)
      document.removeEventListener('touchcancel', handleTouchCancel, true)
    }
  }

  function resetMobileDragCreate(options = {}) {
    const { keepPreview = false } = options
    releaseMobilePointerCapture(mobileDragStartRef.current)
    clearMobileLongPressTimer()
    clearMobileDragDocumentListeners()
    unlockMobileDragScroll()
    mobileDragModeRef.current = 'idle'
    mobileDragStartRef.current = null
    if (!keepPreview) {
      mobileDragSelectionRef.current = null
      setMobileDragSelection(null)
    }
  }

  function startMobileLongPressCreate(e) {
    if (e.isPrimary === false) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.target.closest('.mobile-event-card, input, select, button, textarea')) return

    e.stopPropagation()
    window.getSelection?.().removeAllRanges?.()
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

    resetMobileDragCreate()
    mobileDragModeRef.current = 'pressing'
    mobileDragStartRef.current = startState
    mobileDragSelectionRef.current = null
    setMobileDragSelection(null)
    bindMobileDragDocumentListeners()

    mobileLongPressTimerRef.current = window.setTimeout(() => {
      if (mobileDragModeRef.current !== 'pressing' || mobileDragStartRef.current?.pointerId !== startState.pointerId) {
        mobileLongPressTimerRef.current = null
        return
      }

      window.getSelection?.().removeAllRanges?.()
      mobileDragModeRef.current = 'creating'
      lockMobileDragScroll()
      const nextSelection = {
        anchorMinutes: startState.anchorMinutes,
        currentMinutes: startState.anchorMinutes,
        anchorY: startState.anchorY,
        currentY: startState.anchorY
      }

      try {
        startState.timeline.setPointerCapture?.(startState.pointerId)
      } catch {
        // Some mobile browsers release the pointer before capture is available.
      }
      mobileDragSelectionRef.current = nextSelection
      setMobileDragSelection(nextSelection)
      mobileLongPressTimerRef.current = null
    }, MOBILE_LONG_PRESS_MS)
  }

  function updateMobileDragCreate(e) {
    if (e.isPrimary === false) return
    const startState = mobileDragStartRef.current
    if (!startState) return
    if (!isMatchingMobileDragPointer(e, startState)) return

    const point = pointFromMobileGestureEvent(e)
    if (!point) return

    const distance = Math.hypot(point.clientX - startState.originX, point.clientY - startState.originY)
    if (mobileDragModeRef.current === 'pressing') {
      if (distance > MOBILE_LONG_PRESS_MOVE_CANCEL_PX) {
        resetMobileDragCreate()
      }
      return
    }

    if (mobileDragModeRef.current !== 'creating') return
    if (!mobileDragSelectionRef.current) {
      resetMobileDragCreate()
      return
    }

    preventMobileGestureDefault(e)
    const position = mobilePointerPosition(point, startState.timeline)
    const nextSelection = {
      ...mobileDragSelectionRef.current,
      currentMinutes: position.minutes,
      currentY: position.y
    }

    mobileDragSelectionRef.current = nextSelection
    setMobileDragSelection(nextSelection)
  }

  function finishMobileLongPressCreate(e) {
    if (e.isPrimary === false) return
    const selection = mobileDragSelectionRef.current
    const startState = mobileDragStartRef.current
    if (startState && !isMatchingMobileDragPointer(e, startState)) return

    if (mobileDragModeRef.current === 'pressing') {
      resetMobileDragCreate()
      return
    }

    if (mobileDragModeRef.current !== 'creating' || !selection) {
      resetMobileDragCreate()
      return
    }

    preventMobileGestureDefault(e)
    const point = pointFromMobileGestureEvent(e)
    const finalPosition = startState?.timeline && point
      ? mobilePointerPosition(point, startState.timeline)
      : null
    const finalSelection = finalPosition
      ? {
          ...selection,
          currentMinutes: finalPosition.minutes,
          currentY: finalPosition.y
        }
      : selection
    const range = eventRangeFromSelection(finalSelection.anchorMinutes, finalSelection.currentMinutes)
    resetMobileDragCreate({ keepPreview: true })
    openMobileNewEventModal({
      date: selectedMobileDate,
      startTime: minutesToTime(range.startMinutes),
      endTime: minutesToTime(range.endMinutes)
    })
  }

  function cancelMobileLongPressCreate(e) {
    if (e?.isPrimary === false) return
    if (mobileDragStartRef.current && !isMatchingMobileDragPointer(e)) return
    resetMobileDragCreate()
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
          <div className={`cloud-sync ${cloudStatus}`} title={cloudMessage}>
            <span className="cloud-dot" aria-hidden="true" />
            <span className="cloud-text">{cloudMessage}</span>
          </div>
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
        </div>
      </header>

      <main className={`mobile-view mobile-page-${mobileActivePage}`} aria-label="スマホ専用表示">
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
          <section className="mobile-section mobile-schedule-page" ref={mobileScheduleSectionRef}>
            <div
              className={`mobile-timeline ${mobileDragSelection ? 'creating' : ''}`}
              style={{
                height: `${MOBILE_TIMELINE_HEIGHT}px`,
                '--mobile-hour-height': `${MOBILE_HOUR_HEIGHT}px`
              }}
              onPointerDown={startMobileLongPressCreate}
              onPointerCancel={cancelMobileLongPressCreate}
              onSelect={e => e.preventDefault()}
              onDragStart={e => e.preventDefault()}
              onContextMenu={e => {
                e.preventDefault()
              }}
            >
              <div className="mobile-timeline-grid" aria-hidden="true">
                {MOBILE_TIMELINE_MARKS.map(hour => {
                  const isStartMark = hour === GRID_START_MINUTES / 60
                  const isEndMark = hour === GRID_END_MINUTES / 60
                  const markClassName = [
                    'mobile-hour-row',
                    isStartMark ? 'start' : '',
                    isEndMark ? 'end' : ''
                  ].filter(Boolean).join(' ')

                  return (
                    <div
                      key={hour}
                      className={markClassName}
                      data-hour={hour}
                      style={{ top: `${mobileTimelineYForMinutes(hour * 60)}px` }}
                    >
                      <div className="mobile-hour-label">
                        {`${String(hour).padStart(2, '0')}:00`}
                      </div>
                      {!isStartMark && !isEndMark && <div className="mobile-hour-line" />}
                    </div>
                  )
                })}
              </div>

              {selectedMobileDate === currentDateISO && currentMinutes >= GRID_START_MINUTES && currentMinutes < GRID_END_MINUTES && (
                <div
                  className="mobile-current-time-pointer"
                  style={{ top: `${mobileTimelineYForMinutes(currentMinutes)}px` }}
                  aria-hidden="true"
                >
                  ▶
                </div>
              )}

              {mobileDragSelection && mobileDragRange && (
                <div className="mobile-drag-selection" style={mobileDragPreviewStyle} aria-hidden="true">
                  <span>
                    {mobileDragRange.startMinutes === mobileDragRange.endMinutes
                      ? minutesToTime(mobileDragRange.startMinutes)
                      : `${minutesToTime(mobileDragRange.startMinutes)}〜${minutesToTime(mobileDragRange.endMinutes)}`}
                  </span>
                </div>
              )}

              <div className="mobile-event-layer">
                {selectedMobileEvents.map((event, index) => {
                  const previousEvent = selectedMobileEvents[index - 1]
                  const isConnectedTop = previousEvent?.endTime === event.startTime
                  const className = [
                    'mobile-event-card',
                    'mobile-event-block',
                    isEventInProgress(event) ? 'current-event' : '',
                    isConnectedTop ? 'connected-top' : ''
                  ].filter(Boolean).join(' ')

                  return (
                    <button
                      key={event.id}
                      type="button"
                      className={className}
                      style={mobileEventBlockStyle(event)}
                      onClick={() => openMobileEventModal(event)}
                      aria-label={`${event.startTime}〜${event.endTime} ${event.title || '無題の予定'}`}
                    >
                      <span className="mobile-event-title">{event.title || '無題の予定'}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          </section>
        )}

        {mobileActivePage === 'tasks' && (
          <section className="mobile-section mobile-task-section">
            <div className="mobile-section-heading">
              <h2>タスク</h2>
              <span>{selectedMobileTasks.length}件</span>
            </div>
            {selectedMobileTasks.length === 0 ? (
              <p className="mobile-empty">この日のタスクはありません</p>
            ) : (
              <ul
                className={`mobile-task-list ${mobileTaskDragState?.dragging ? 'dragging' : ''}`}
                ref={mobileTaskListRef}
              >
                {selectedMobileTasks.map(task => (
                  <li
                    key={task.id}
                    className={[
                      'mobile-task-item',
                      task.completed ? 'completed' : '',
                      mobileTaskDragState?.taskId === task.id && mobileTaskDragState?.dragging ? 'dragging' : '',
                      mobileTaskDragState?.beforeTaskId === task.id && mobileTaskDragState?.taskId !== task.id ? 'drag-over-before' : ''
                    ].filter(Boolean).join(' ')}
                    data-mobile-task-id={task.id}
                    onPointerDown={e => startMobileTaskReorder(e, task.id)}
                    onClickCapture={suppressMobileTaskClickAfterDrag}
                  >
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
                <li
                  className={`mobile-task-drop-end ${mobileTaskDragState?.dragging && !mobileTaskDragState.beforeTaskId ? 'active' : ''}`}
                  aria-hidden="true"
                />
              </ul>
            )}
            <form className="mobile-add-form mobile-task-form" onSubmit={addMobileTask}>
              <input
                type="text"
                placeholder="タスクタイトル"
                value={mobileTaskDraft}
                onChange={e => setMobileTaskDraft(e.target.value)}
              />
              <button type="submit">追加</button>
            </form>
          </section>
        )}

        {mobileActivePage === 'month' && (
          <section className="mobile-section mobile-month-page">
            <div className="mobile-month-header">
              <button type="button" onClick={() => changeMonthView(-1)} aria-label="前月">&lt;</button>
              <strong>{monthViewTitle}</strong>
              <button type="button" onClick={() => changeMonthView(1)} aria-label="翌月">&gt;</button>
            </div>
            <div className="mobile-month-calendar-shell">
              <div className="mobile-month-weekdays" aria-hidden="true">
                {MONDAY_WEEKDAY_LABELS.map(day => (
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

                  return (
                    <button
                      type="button"
                      key={dateISO}
                      className={`mobile-month-day ${weekendClass} ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''}`}
                      onClick={() => selectMonthDate(dateISO)}
                    >
                      <span className="mobile-month-date">{date.getDate()}</span>
                      {dayEvents.length > 0 && (
                        <span className="mobile-month-day-events">
                          {dayEvents.slice(0, 2).map(event => (
                            <span className="mobile-month-event-chip" key={event.id}>
                              {event.title || '無題の予定'}
                            </span>
                          ))}
                          {dayEvents.length > 2 && (
                            <span className="mobile-month-event-more">+{dayEvents.length - 2}</span>
                          )}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>
            <div className="mobile-month-detail">
              {selectedMonthEvents.length === 0 ? (
                <p className="mobile-empty">この日の予定はありません</p>
              ) : (
                <ul className="mobile-month-event-list">
                  {selectedMonthEvents.map(event => (
                    <li key={event.id} className={`mobile-month-detail-event ${isEventInProgress(event) ? 'current-event' : ''}`}>
                      <button type="button" onClick={() => openMobileEventModal(event)}>
                        <span className="mobile-month-detail-time">{event.startTime}〜{event.endTime}</span>
                        <span className="mobile-month-detail-name">{event.title || '無題の予定'}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <button
              type="button"
              className="mobile-month-add-button"
              onClick={() => openMobileNewEventModal({ date: selectedMonthDate })}
              aria-label="選択日に予定を追加"
            >
              +
            </button>
          </section>
        )}

        {mobileActivePage === 'memo' && (
          <section className="mobile-section mobile-memo-page">
            <div className="mobile-section-heading">
              <h2>メモ</h2>
              <span>プランナー共通</span>
            </div>
            <textarea
              value={mobileMemoText}
              onChange={e => updateMemo(e.target.value)}
              placeholder="メモを書く..."
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

          <div
            className="timetable weekly"
            ref={plannerTimetableRef}
            style={{ '--hour-height': `${plannerHourHeight}px` }}
          >
              <div className="timetable-grid">
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
                          {PLANNER_SLOT_HOURS.map(hour => (
                            <div
                              key={hour}
                              className="slot"
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
                                top: gridTopFromMinutes(dragRange.startMinutes, plannerHourHeight) + 'px',
                                height: gridHeightFromMinutes(dragRange.startMinutes, dragRange.endMinutes, plannerHourHeight) + 'px',
                                '--event-grid-offset': -gridTopFromMinutes(dragRange.startMinutes, plannerHourHeight) + 'px'
                              }}
                            />
                          )}

                          {dayEvents.map((ev, index) => {
                            const previousEvent = dayEvents[index - 1]
                            const startMinutes = minutesFromTime(ev.startTime)
                            const endMinutes = minutesFromTime(ev.endTime)
                            const durationMinutes = endMinutes - startMinutes
                            const sizeClass = durationMinutes <= 30 ? 'short-event' : durationMinutes <= 60 ? 'compact-event' : ''
                            const connectedClass = previousEvent?.endTime === ev.startTime ? 'connected-top' : ''
                            return (
                              <div
                                key={ev.id}
                                className={`event-block ${ev.source === GOOGLE_EVENT_SOURCE ? 'google-event' : ''} ${isEventInProgress(ev) ? 'current-event' : ''} ${sizeClass} ${connectedClass}`}
                                style={{
                                  top: gridTopFromMinutes(startMinutes, plannerHourHeight) + 'px',
                                  height: Math.max(1, gridHeightFromMinutes(startMinutes, endMinutes, plannerHourHeight)) + 'px',
                                  '--event-grid-offset': -gridTopFromMinutes(startMinutes, plannerHourHeight) + 'px'
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
          <div className="dashboard-card dashboard-calendar-card">
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
              {MONDAY_WEEKDAY_LABELS.map(day => (
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
              </div>
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
              {MONDAY_WEEKDAY_LABELS.map(day => (
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
              {MONDAY_WEEKDAY_LABELS.map(day => (
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

      {isEventModalOpen && (
        <div className="mobile-event-modal-backdrop" role="presentation" onClick={closeMobileEventModal}>
          <form
            className="mobile-event-modal"
            onClick={e => e.stopPropagation()}
            onSubmit={saveMobileEventModal}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-event-modal-title"
          >
            <h3 id="mobile-event-modal-title">予定を編集</h3>
            <label className="mobile-event-modal-field">
              <span>タイトル</span>
              <input
                type="text"
                value={draftEventTitle}
                onChange={e => setDraftEventTitle(e.target.value)}
                placeholder="予定タイトル"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
            </label>
            <label className="mobile-event-modal-field">
              <span>日付</span>
              <input
                type="date"
                value={draftEventDate}
                onChange={e => setDraftEventDate(e.target.value)}
              />
            </label>
            <div className="mobile-event-modal-time-row">
              <label className="mobile-event-modal-field">
                <span>開始</span>
                <select value={draftEventStart} onChange={e => updateDraftEventStart(e.target.value)}>
                  {START_TIME_OPTIONS.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
              </label>
              <label className="mobile-event-modal-field">
                <span>終了</span>
                <select value={draftEventEnd} onChange={e => setDraftEventEnd(e.target.value)}>
                  {draftEventEndOptions.map(slot => (
                    <option key={slot} value={slot}>{slot}</option>
                  ))}
                </select>
              </label>
            </div>
            <div className="mobile-event-modal-actions">
              <button type="button" className="cancel" onClick={closeMobileEventModal}>
                キャンセル
              </button>
              {editingEventId && (
                <button type="button" className="delete" onClick={deleteMobileEventModal}>
                  削除
                </button>
              )}
              <button type="submit" className="save">
                保存
              </button>
            </div>
          </form>
        </div>
      )}

      {editing && <EventForm initial={editing} onSave={saveEvent} onDelete={deleteEvent} onCancel={() => setEditing(null)} />}
    </div>
  )
}
