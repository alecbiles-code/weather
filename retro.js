// The 90s bits: Start menu, taskbar clock, sparkle trail, LED ticker, daily picks, guestbook.
import {TZ, parseCSV, dailyPick, localDate, request} from './core.js';

const $ = id => document.getElementById(id);
export const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
export const animOn = () => document.documentElement.classList.contains('anim-on');

/* ---- Start menu, clock, sparkles ---- */
export function initChrome() {
  const btn = $('startButton'), menu = $('startMenu');
  const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
  btn.addEventListener('click', e => { e.stopPropagation(); const open = menu.hidden; menu.hidden = !open; btn.setAttribute('aria-expanded', String(open)); if (open) menu.querySelector('a, button')?.focus(); });
  document.addEventListener('click', e => { if (!menu.hidden && !menu.contains(e.target)) close(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { close(); btn.focus(); } });
  menu.addEventListener('click', e => { // every item closes the menu; buttons hand focus back to Start
    if (e.target.closest('a')) close();
    else if (e.target.closest('button')) { close(); btn.focus(); }
  });
  const tick = () => { $('clock').textContent = new Intl.DateTimeFormat('en-US', {timeZone: TZ, hour: 'numeric', minute: '2-digit'}).format(new Date()); };
  tick(); setInterval(tick, 30000);
  let last = 0;
  document.addEventListener('pointermove', e => {
    if (e.pointerType !== 'mouse' || !animOn() || e.timeStamp - last < 45) return;
    last = e.timeStamp;
    const s = document.createElement('span');
    s.className = 'sparkle'; s.textContent = Math.random() < 0.5 ? '*' : '+'; s.setAttribute('aria-hidden', 'true');
    s.style.left = `${e.clientX + 6}px`; s.style.top = `${e.clientY + 6}px`; s.style.setProperty('--dx', `${(Math.random() - 0.5) * 24}px`);
    document.body.append(s);
    setTimeout(() => s.remove(), 750);
  }, {passive: true});
}

/** Items are trusted HTML built by the app from escaped values. Written only when they change, so the ticker does not restart. */
export function setTicker(items) {
  const html = items.map(i => `<span>&#9733; ${i}</span>`).join(''), el = $('ticker');
  if (el.dataset.html === html) return;
  el.dataset.html = html; el.innerHTML = html;
  $('tickerText').textContent = el.textContent;
}

/* ---- Skier of the Day and Alec's Fun Fact (lists live in data/*.csv) ---- */
export async function loadLists() {
  const get = async path => { try { return parseCSV(await request(path, {as: 'text', init: {cache: 'no-cache'}})); } catch { return []; } };
  const [skiers, facts] = await Promise.all([get('data/skiers.csv'), get('data/facts.csv')]);
  return {skiers: skiers.filter(s => s.first_name || s.nickname), facts: facts.map(f => f.fact).filter(Boolean)};
}
export function skierHTML(list) {
  const s = dailyPick(list, localDate());
  if (!s) return '<p class="muted">Add skiers to data/skiers.csv.</p>';
  const name = [s.first_name, s.last_name].filter(Boolean).join(' ');
  const nick = s.nickname && s.nickname !== name ? s.nickname : ''; // skip a nickname that just repeats the name
  return `<p><span class="new">NEW!</span></p><p class="skier-name">${esc(name || s.nickname)}</p>
    ${nick ? `<p>Nickname: <b>${esc(nick)}</b></p>` : ''}${s.home ? `<p class="skier-sub">Home: ${esc(s.home)}</p>` : ''}
    <p class="box-foot">A new skier every day at midnight hell yeah.</p>`;
}
export function factHTML(list) {
  const f = dailyPick(list, localDate());
  return f ? `<p class="fact">"${esc(f)}"</p><p class="box-foot">All facts very true. New fact every day.</p>` : '<p class="muted">Add facts to data/facts.csv.</p>';
}
export const todaysSkier = list => dailyPick(list, localDate());
export const todaysFact = list => dailyPick(list, localDate());

/* ---- Guestbook: a Google Form collects entries, its published Sheet CSV displays them ---- */
const gb = {config: null, entries: [], pending: [], error: null};
export async function loadGuestbook() {
  try { gb.config = await request('data/guestbook.json', {init: {cache: 'no-cache'}}); } catch { gb.config = null; }
  const c = gb.config;
  if (!c?.formUrl || !c.nameEntry || !c.messageEntry || !c.sheetCsvUrl) { gb.config = null; return false; }
  try {
    const rows = parseCSV(await request(c.sheetCsvUrl, {as: 'text', init: {cache: 'no-cache'}}));
    const key = (row, re) => Object.keys(row).find(k => re.test(k));
    gb.entries = rows.map(row => ({time: row[key(row, /time/i)] || '', name: row[key(row, /name/i)] || '', message: row[key(row, /comment|message/i)] || ''}))
      .filter(e => e.name && e.message).reverse().slice(0, 80);
    gb.error = null;
  } catch (e) { gb.error = e.message; }
  return true;
}
export function guestbookHTML() {
  if (!gb.config) return '';
  const list = [...gb.pending, ...gb.entries];
  return `<div class="win" id="guestbook"><div class="titlebar"><svg class="icon" aria-hidden="true"><use href="#i-doc"/></svg><h2>Guestbook - sign it!</h2><span class="title-btns" aria-hidden="true"><i>_</i><i>&#9633;</i><i>&times;</i></span></div><div class="win-body">
    <form class="guest-form" id="guestForm" autocomplete="off">
      <label>Your name<input type="text" name="name" maxlength="40" required></label>
      <label>Comment<textarea name="message" maxlength="500" rows="2" required></textarea></label>
      <label class="hp" aria-hidden="true">Leave empty<input type="text" name="website" tabindex="-1"></label>
      <button type="submit" class="btn">Sign guestbook</button>
    </form>
    ${gb.error ? `<p class="notice">Entries could not load (${esc(gb.error)}).</p>` : ''}
    <ul class="guest-list">${list.length ? list.map(e => `<li><b>${esc(e.name)}</b><time>${esc(e.time)}</time><p>${esc(e.message)}</p></li>`).join('') : '<li class="muted">No entries yet. Be the first!</li>'}</ul>
    <p class="note">No account needed. New entries show up within a few minutes.</p></div></div>`;
}
/** Returns a message for a toast. The POST is opaque (no-cors), so success means "sent". */
export async function submitGuestbook(form) {
  const f = new FormData(form), name = String(f.get('name') || '').trim(), message = String(f.get('message') || '').trim();
  if (f.get('website')) return 'Thanks!'; // honeypot: bots fill hidden fields
  if (!name || !message) return 'Please add your name and a comment.';
  let lastPost = 0;
  try { lastPost = +localStorage.getItem('powcast-guestbook-at') || 0; } catch { /* storage blocked */ }
  if (Date.now() - lastPost < 60000) return 'One entry a minute, please.';
  const body = new FormData();
  body.append(gb.config.nameEntry, name.slice(0, 40));
  body.append(gb.config.messageEntry, message.slice(0, 500));
  await fetch(gb.config.formUrl, {method: 'POST', mode: 'no-cors', body, signal: AbortSignal.timeout(15000)}); // a post is not retried: it could sign twice
  try { localStorage.setItem('powcast-guestbook-at', String(Date.now())); } catch { /* storage blocked */ }
  gb.pending.unshift({time: 'just now', name, message});
  return 'Signed! Your entry will appear for everyone within a few minutes.';
}
