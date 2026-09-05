const API = API_BASE_URL || 'http://127.0.0.1:3000';
const CONTROL = PROXY_CONTROL_URL || 'http://127.0.0.1:8474';
const ZONE = 'America/New_York';

function parts(instant) {
  const formatted = new Intl.DateTimeFormat('en-US', {
    timeZone: ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const value = (kind) => formatted.find((part) => part.type === kind).value;
  return {
    date: `${value('year')}-${value('month')}-${value('day')}`,
    time: `${value('hour')}:${value('minute')}`,
  };
}

function addWallDay(date) {
  const fields = date.split('-').map(Number);
  const next = new Date(Date.UTC(fields[0], fields[1] - 1, fields[2] + 1));
  return next.toISOString().slice(0, 10);
}

function addWallDays(date, days) {
  const fields = date.split('-').map(Number);
  const next = new Date(Date.UTC(fields[0], fields[1] - 1, fields[2] + days));
  return next.toISOString().slice(0, 10);
}

function timeLabel(time) {
  const fields = time.split(':').map(Number);
  const period = fields[0] >= 12 ? 'PM' : 'AM';
  const hour = fields[0] % 12 || 12;
  return `${hour}:${String(fields[1]).padStart(2, '0')} ${period}`;
}

// Maestro scripts do not expose Node's crypto module. These UUIDs identify test
// writes only; they are not credentials or capability tokens.
function fixtureUuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (kind) => {
    const value = Math.floor(Math.random() * 16);
    return (kind === 'x' ? value : (value & 3) | 8).toString(16);
  });
}

function headers(idempotent) {
  const result = {
    'Content-Type': 'application/json',
    'X-Request-Id': `req_maestro_${Date.now()}_${Math.random().toString(16).slice(2)}`,
    'X-Client-Timezone': ZONE,
    'X-Client-Version': 'ios/maestro',
  };
  if (idempotent) result['Idempotency-Key'] = fixtureUuid();
  return result;
}

function create(title, date, time, recurrence) {
  const schedule = { date, timezone: ZONE };
  if (time) schedule.time = time;
  const body = {
    objectKind: 'task',
    type: 'task',
    title,
    details: { kind: 'task' },
    schedule,
  };
  if (recurrence) body.recurrence = recurrence;
  const response = http.post(`${API}/v1/activities`, {
    headers: headers(true),
    body: JSON.stringify(body),
  });
  const envelope = JSON.parse(response.body);
  if (!envelope.data?.activityId) {
    throw new Error(`Fixture create failed: ${response.body}`);
  }
  return envelope.data.activityId;
}

function createPlan(title, date) {
  const response = http.post(`${API}/v1/activities`, {
    headers: headers(true),
    body: JSON.stringify({
      objectKind: 'plan',
      type: 'custom',
      title,
      details: { kind: 'custom' },
      schedule: { date, timezone: ZONE },
    }),
  });
  const envelope = JSON.parse(response.body);
  if (!envelope.data?.activityId) {
    throw new Error(`Fixture Plan create failed: ${response.body}`);
  }
  return envelope.data.activityId;
}

function createList(title) {
  const response = http.post(`${API}/v1/lists`, {
    headers: headers(true),
    body: JSON.stringify({ title, templateKey: 'blank' }),
  });
  const envelope = JSON.parse(response.body);
  if (!envelope.data?.listId) {
    throw new Error(`Fixture List create failed: ${response.body}`);
  }
  return envelope.data.listId;
}

http.post(`${CONTROL}/online`, { body: '' });
const stamp = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
const now = new Date();
const wall = parts(now);
output.today = wall.date;
output.tomorrow = addWallDay(wall.date);
output.activityIds = [];

if (FLOW.startsWith('calendar-')) {
  const fields = wall.date.split('-').map(Number);
  const offset =
    FLOW === 'calendar-year-boundary' ? 13 - fields[1] : Number(CALENDAR_MONTH_OFFSET);
  const target = new Date(
    Date.UTC(
      fields[0],
      fields[1] - 1 + offset,
      FLOW === 'calendar-year-boundary' ? 1 : 15,
    ),
  );
  output.targetDate = target.toISOString().slice(0, 10);
  output.neighborDate = addWallDays(output.targetDate, 1);
  output.targetMonth = output.targetDate.slice(0, 7);
  const first = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
  output.gridFrom = addWallDays(
    first.toISOString().slice(0, 10),
    -((first.getUTCDay() + 6) % 7),
  );
  output.gridThrough = addWallDays(
    last.toISOString().slice(0, 10),
    6 - ((last.getUTCDay() + 6) % 7),
  );
  output.yearSteps = Math.abs(target.getUTCFullYear() - fields[0]);
  output.calendarPast = offset < 0;
  output.targetTitle = `Calendar target ${output.targetDate} ${stamp}`;
  output.neighborTitle = `Calendar neighbor ${stamp}`;
  output.todayTitle = `Calendar Today ${stamp}`;
  output.activityIds.push(create(output.targetTitle, output.targetDate, '12:00'));
  output.activityIds.push(
    create(output.neighborTitle, addWallDays(output.targetDate, 1), '12:00'),
  );
  output.activityIds.push(create(output.todayTitle, wall.date));
  if (FLOW === 'calendar-dense-year') {
    output.backwardDate = addWallDays(output.targetDate, -2);
    output.backwardTitle = `Calendar backward ${output.backwardDate} ${stamp}`;
    output.activityIds.push(create(output.backwardTitle, output.backwardDate, '12:00'));
    output.activityIds.push(
      create(`Calendar daily density ${stamp}`, wall.date, '09:00', {
        mode: 'fixed',
        segments: [{ freq: 'daily', effectiveFrom: wall.date }],
      }),
    );
  }
} else if (FLOW === 'recurring-create-window') {
  output.title = `Native new daily ${stamp}`;
  output.afterWeek = addWallDays(wall.date, 8);
} else if (FLOW === 'add-and-complete') {
  output.title = `P2-37 iOS add ${stamp}`;
} else if (FLOW === 'prep-parent-reconciliation') {
  output.planTitle = `P3 native Prep parent ${stamp}`;
  output.prepTitle = `Book room ${stamp}`;
  output.activityId = createPlan(output.planTitle, wall.date);
  output.activityIds.push(output.activityId);
  output.cleanupTitles = [output.prepTitle];
} else if (FLOW === 'source-list-reconciliation') {
  output.planTitle = `P3 native List source ${stamp}`;
  output.listTitle = `Packing ${stamp}`;
  output.indexListTitle = `Errands ${stamp}`;
  output.activityId = createPlan(output.planTitle, wall.date);
  output.indexListId = createList(output.indexListTitle);
  output.activityIds.push(output.activityId);
  output.cleanupListTitles = [output.listTitle, output.indexListTitle];
} else if (FLOW === 'schedule-plans-reconciliation') {
  output.planTitle = `P3 native Plans schedule ${stamp}`;
  output.activityId = createPlan(output.planTitle, wall.date);
  output.activityIds.push(output.activityId);
} else if (FLOW === 'plans-live-projection') {
  output.title = `P3 native Plans task ${stamp}`;
  output.planTitle = `P3 native Plans done ${stamp}`;
  output.planId = createPlan(output.planTitle, wall.date);
  output.activityIds.push(output.planId);
} else if (FLOW === 'attachment-native-projection') {
  output.planTitle = `P3 native attachment ${stamp}`;
  output.activityId = createPlan(output.planTitle, wall.date);
  output.activityIds.push(output.activityId);
} else if (FLOW === 'snooze-occurrence') {
  output.title = `P2-37 iOS snooze ${stamp}`;
  const originalWall = parts(new Date(now.getTime() + 5 * 60 * 1000));
  const snoozeWall = parts(new Date(now.getTime() + 20 * 60 * 1000));
  if (originalWall.date !== wall.date || snoozeWall.date !== wall.date) {
    throw new Error('Run the snooze flow before the final 20 minutes of the local day.');
  }
  output.originalTime = originalWall.time;
  output.originalTimeLabel = timeLabel(originalWall.time);
  output.snoozeTimeLabel = timeLabel(snoozeWall.time);
  output.activityId = create(output.title, wall.date, originalWall.time, {
    mode: 'fixed',
    segments: [{ freq: 'daily', effectiveFrom: wall.date }],
  });
  output.activityIds.push(output.activityId);
} else if (FLOW === 'recurrence-stabilization') {
  output.title = `P2-55 iOS recurrence ${stamp}`;
  const occurrenceWall = parts(new Date(now.getTime() + 5 * 60 * 1000));
  if (occurrenceWall.date !== wall.date) {
    throw new Error(
      'Run the recurrence flow outside the final five minutes of the local day.',
    );
  }
  output.originalTimeLabel = timeLabel(occurrenceWall.time);
  output.activityId = create(output.title, wall.date, occurrenceWall.time, {
    mode: 'fixed',
    segments: [{ freq: 'daily', effectiveFrom: wall.date }],
  });
  output.activityIds.push(output.activityId);
} else if (FLOW === 'recurring-past-history') {
  output.title = `P3 recurring Past ${stamp}`;
  output.yesterday = addWallDays(wall.date, -1);
  output.completedDate = addWallDays(wall.date, -2);
  output.activityId = create(output.title, output.completedDate, '09:00', {
    mode: 'fixed',
    segments: [{ freq: 'daily', effectiveFrom: output.completedDate }],
  });
  output.activityIds.push(output.activityId);
  const response = http.post(`${API}/v1/activities/${output.activityId}/complete`, {
    headers: headers(true),
    body: JSON.stringify({ occurrenceDate: output.completedDate }),
  });
  const envelope = JSON.parse(response.body);
  if (!envelope.data) {
    throw new Error(`Fixture occurrence completion failed: ${response.body}`);
  }
} else if (FLOW === 'up-next-ticker') {
  // The current minute can end during launch. Seed future minute boundaries;
  // the flow waits for the second boundary before checking foreground recomputation.
  const nextMinute = new Date(Math.floor(now.getTime() / 60000) * 60000 + 60000);
  const secondMinute = new Date(nextMinute.getTime() + 60000);
  const nextWall = parts(nextMinute);
  const secondWall = parts(secondMinute);
  if (secondWall.date !== wall.date)
    throw new Error(
      'Run the ticker flow outside the final two minutes of the local day.',
    );
  output.firstTitle = `P2-37 iOS ticker first ${stamp}`;
  output.secondTitle = `P2-37 iOS ticker second ${stamp}`;
  output.firstId = create(output.firstTitle, wall.date, nextWall.time);
  output.secondId = create(output.secondTitle, wall.date, secondWall.time);
  output.activityIds.push(output.firstId, output.secondId);
  output.advanceAfterEpoch = secondMinute.getTime() + 1000;
} else if (FLOW === 'offline-queue-relaunch') {
  output.titles = [];
  for (let index = 1; index <= 3; index += 1) {
    const title = `P2-37 iOS offline ${index} ${stamp}`;
    output.titles.push(title);
    output[`offlineTitle${index}`] = title;
    const activityId = create(
      title,
      wall.date,
      undefined,
      index === 1
        ? { mode: 'fixed', segments: [{ freq: 'daily', effectiveFrom: wall.date }] }
        : undefined,
    );
    if (index === 1) output.recurringOfflineId = activityId;
    output.activityIds.push(activityId);
  }
} else {
  throw new Error(`Unknown P2-37 flow: ${FLOW}`);
}

http.post(`${CONTROL}/reset`, { body: '' });
