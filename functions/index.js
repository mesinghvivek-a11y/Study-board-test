const { onDocumentCreated, onDocumentUpdated } = require('firebase-functions/v2/firestore');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const admin = require('firebase-admin');

admin.initializeApp();
const db = admin.firestore();

const DEFAULTS = { timerEnd:true, taskApproaching:true, studyStart:true, taskComment:true, groupChanges:true };

async function canNotify(uid, category){
  const snap = await db.doc(`notificationSettings/${uid}`).get();
  const s = Object.assign({}, DEFAULTS, snap.exists ? snap.data() : {});
  return s[category] !== false;
}

async function sendToUser(uid, title, body, url='./index.html'){
  const snap = await db.doc(`pushTokens/${uid}`).get();
  if(!snap.exists) return;
  const data = snap.data() || {};
  let tokens = Array.isArray(data.tokens) ? data.tokens.slice() : (data.token ? [data.token] : []);
  tokens = [...new Set(tokens.filter(Boolean))];
  if(!tokens.length) return;
  const msg = {
    tokens,
    notification:{title, body},
    data:{url},
    webpush:{
      fcmOptions:{link:url},
      notification:{icon:'./icons/icon-192.png', badge:'./icons/icon-192.png'}
    }
  };
  try{
    const res = await admin.messaging().sendEachForMulticast(msg);
    const bad = new Set();
    (res.responses||[]).forEach((r,i)=>{
      if(!r.success && r.error && /registration-token-not-registered|invalid-argument/i.test(r.error.code||'')) bad.add(tokens[i]);
    });
    if(bad.size){
      tokens = tokens.filter(t=>!bad.has(t));
      await db.doc(`pushTokens/${uid}`).set({tokens, updatedAt:Date.now()},{merge:true});
    }
  }catch(e){ console.error('FCM send failed', e); }
}

exports.pushNotificationEvents = onDocumentCreated('notificationEvents/{uid}/events/{eventId}', async (event)=>{
  const uid = event.params.uid;
  const data = event.data.data() || {};
  const category = data.category || 'taskComment';
  if(!(await canNotify(uid, category))) return;
  await sendToUser(uid, 'Study Board', data.text || 'You have a new Study Board notification', data.url || './index.html');
});

exports.watchTimerAndTaskAlerts = onSchedule({ schedule:'every 1 minutes', timeZone:'Asia/Kolkata', region:'asia-south1' }, async ()=>{
  const now = Date.now();
  const soonMin = now + 5*60*1000;
  const [timerSnap, boardsSnap] = await Promise.all([
    db.collection('timerSchedules').where('active','==',true).where('endsAt','<=',now+65*1000).get(),
    db.collection('boards').get()
  ]);

  // Timer end reminders, including when the PWA is closed.
  for(const d of timerSnap.docs){
    const uid=d.id, t=d.data()||{};
    if(!t.endsAt || t.endsAt > now+65*1000) continue;
    const sentRef=db.doc(`scheduledNotificationState/${uid}_timerEnd`);
    const sent=await sentRef.get();
    if(sent.exists && sent.data().forEndsAt===t.endsAt) continue;
    if(await canNotify(uid,'timerEnd')){
      const body=t.title ? `${t.title} is complete.` : 'Your focus timer is complete.';
      await db.collection('notifications').doc(uid).set({items: admin.firestore.FieldValue.arrayUnion({text:`Focus timer finished 🎉`,ts:now,read:false,category:'timerEnd'})},{merge:true});
      await sendToUser(uid,'Focus timer finished',body);
    }
    await sentRef.set({forEndsAt:t.endsAt, updatedAt:now});
    await d.ref.set({active:false, processedAt:now},{merge:true});
  }

  // Task starting-soon reminders. This intentionally scans user boards because
  // the app's daily schedule is stored as a value object inside boards/{uid}.
  const parts = new Intl.DateTimeFormat('en-CA', {timeZone:'Asia/Kolkata', year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', hour12:false}).formatToParts(new Date(now));
  const pv=Object.fromEntries(parts.map(p=>[p.type,p.value]));
  const key = `${pv.year}-${pv.month}-${pv.day}`;
  const minutesNow = Number(pv.hour)*60 + Number(pv.minute);
  const weekday = new Intl.DateTimeFormat('en-US', {timeZone:'Asia/Kolkata', weekday:'short'}).format(new Date(now));
  const weekdayIndex = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(weekday);
  for(const bd of boardsSnap.docs){
    const uid=bd.id;
    if(!(await canNotify(uid,'taskApproaching'))) continue;
    const value=(bd.data()||{}).value||{};
    const tasks = Array.isArray((value.dailyExtra||{})[key]) ? (value.dailyExtra||{})[key].slice() : [];
    // Include weekly template tasks for the current day when they are bound to the current week.
    for(const t of (value.weeklyTemplate||[])){
      if(!t || Number(t.day)!==weekdayIndex) continue;
      if(t.weekStart && t.weekStart!==key && !String(t.weekStart).startsWith(key.slice(0,7))) continue;
      tasks.push(t);
    }
    for(const t of tasks){
      if(!t || !t.start || !t.id) continue;
      const [hh,mm]=String(t.start).split(':').map(Number);
      if(!Number.isFinite(hh)||!Number.isFinite(mm)) continue;
      const target=hh*60+mm;
      const diff=target-minutesNow;
      if(diff<4 || diff>5) continue;
      const stateId=`${uid}_${key}_${t.id}_approach5`;
      const sentRef=db.doc(`scheduledNotificationState/${stateId}`);
      const sent=await sentRef.get();
      if(sent.exists) continue;
      const label=t.label || 'Study task';
      await db.collection('notifications').doc(uid).set({items: admin.firestore.FieldValue.arrayUnion({text:`Task starting in 5 minutes: ${label}`,ts:now,read:false,category:'taskApproaching'})},{merge:true});
      await sendToUser(uid,'Task in 5 minutes',label);
      await sentRef.set({sentAt:now});
    }
  }
});

