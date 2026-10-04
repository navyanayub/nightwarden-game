/**
 * Stage 4 HUD: crime notifications, the active-crime list with timers, the wanted level (five
 * badges, flashing while the police search, with an escape-cooldown bar), money, a scrolling
 * police-scanner text feed, the Vellmoor Gazette news ticker reporting the hero's actions, and the
 * record screen (J): crimes stopped, reputation, Police Trust, gang control per district.
 */
import { events } from '../core/EventBus';
import { DISTRICT_NAMES, type District } from '../world/WorldConfig';
import { GANGS, GANG_IDS, CONTROL_DISTRICTS, type Territory } from '../crime/Gangs';
import type { Stats } from '../crime/Stats';
import { CRIME_DEFS, CRIME_TYPES } from '../crime/Crimes';

const BADGE = `<svg viewBox="0 0 24 24"><path d="M12 2 L20 5.5 V11.5 C20 16.5 16.6 20 12 22 C7.4 20 4 16.5 4 11.5 V5.5 Z"/></svg>`;

export class CrimeHUD {
  private wantedEl: HTMLElement;
  private badges: HTMLElement[] = [];
  private wantedBar: HTMLElement;
  private wantedLabel: HTMLElement;
  private moneyEl: HTMLElement;
  private crimeList: HTMLElement;
  private notify: HTMLElement;
  private scanner: HTMLElement;
  private ticker: HTMLElement;
  private tickerText: HTMLElement;
  private record: HTMLElement;
  private recordBody: HTMLElement;
  open = false;
  private news: string[] = [];
  private tickerOffset = 0;
  private lastMoney = -1;

  constructor(root: HTMLElement) {
    const el = (cls: string, html = '') => {
      const d = document.createElement('div');
      d.className = cls;
      d.innerHTML = html;
      root.appendChild(d);
      return d;
    };
    this.wantedEl = el('hud-wanted', `<div class="badges">${BADGE.repeat(5)}</div><div class="wlabel"></div><div class="wbar"><i></i></div>`);
    this.badges = [...this.wantedEl.querySelectorAll('svg')] as unknown as HTMLElement[];
    this.wantedBar = this.wantedEl.querySelector('.wbar i') as HTMLElement;
    this.wantedLabel = this.wantedEl.querySelector('.wlabel') as HTMLElement;
    this.moneyEl = el('hud-money', '$0');
    this.crimeList = el('hud-crimes');
    this.notify = el('hud-notify');
    this.scanner = el('hud-scanner');
    this.ticker = el('hud-ticker', '<b>VELLMOOR GAZETTE</b><div class="track"><span></span></div>');
    this.tickerText = this.ticker.querySelector('span') as HTMLElement;
    this.record = el('overlay record-overlay', '<div class="panel record"><h2>The Nightwarden — Record</h2><div class="record-body"></div><p class="muted">J or Esc to close</p></div>');
    this.recordBody = this.record.querySelector('.record-body') as HTMLElement;
    events.on('police:scanner', (s) => this.scan(s.text, !!s.priority));
    events.on('news', (n) => this.addNews(n.text));
    events.on('crime:start', (c) => {
      const d = CRIME_DEFS[c.type as keyof typeof CRIME_DEFS];
      this.flash(`<span class="ic">${d?.icon ?? '!'}</span> ${c.label}`, 'crime');
    });
    events.on('crime:end', (c) => {
      const txt: Record<string, string> = { stopped: 'Crime stopped', police: 'Handled by police', failed: 'Crime not stopped — victims hurt', escaped: 'The criminals escaped' };
      this.flash(txt[c.outcome], c.outcome === 'stopped' ? 'good' : c.outcome === 'police' ? 'neutral' : 'bad');
    });
    events.on('wanted:change', (w) => {
      if (w.level > 0 && w.reason !== 'debug') this.flash(`Wanted level ${w.level}`, 'bad');
      if (w.level === 0 && w.reason === 'escaped') this.flash('You lost the police', 'good');
    });
    events.on('player:respawn', (r) => this.flash(r.where === 'hospital' ? `Port Vellmoor General Hospital — bill $${r.fine}` : `Released from VPD Precinct 1 — fine $${r.fine}`, 'neutral'));
    this.addNews('Port Vellmoor wakes to another day of rumours about a masked figure on the rooftops');
  }

  private flash(html: string, kind: string): void {
    const d = document.createElement('div');
    d.className = `note ${kind}`;
    d.innerHTML = html;
    this.notify.prepend(d);
    while (this.notify.children.length > 3) this.notify.lastElementChild!.remove();
    setTimeout(() => d.classList.add('out'), 5200);
    setTimeout(() => d.remove(), 6000);
  }

  private scan(text: string, urgent: boolean): void {
    const d = document.createElement('div');
    d.className = `line${urgent ? ' urgent' : ''}`;
    d.textContent = text;
    this.scanner.appendChild(d);
    while (this.scanner.children.length > 6) this.scanner.firstElementChild!.remove();
    setTimeout(() => d.classList.add('old'), 14000);
  }

  private addNews(text: string): void {
    this.news.unshift(text);
    if (this.news.length > 6) this.news.pop();
    this.tickerText.textContent = this.news.join('   ◆   ');
    this.tickerOffset = 0;
  }

  /** Per frame. */
  update(
    dt: number,
    show: boolean,
    o: {
      wanted: number;
      searching: boolean;
      cool: number;
      money: number;
      crimes: { x: number; z: number; label: string; left: number; icon: string; escape: boolean }[];
      px: number;
      pz: number;
    },
  ): void {
    const vis = show ? '' : 'none';
    for (const e of [this.wantedEl, this.moneyEl, this.crimeList, this.notify, this.scanner, this.ticker]) e.style.display = vis;
    if (!show) return;
    // Wanted.
    this.wantedEl.classList.toggle('on', o.wanted > 0);
    this.wantedEl.classList.toggle('searching', o.searching);
    this.badges.forEach((b, i) => b.classList.toggle('lit', i < o.wanted));
    this.wantedLabel.textContent = o.wanted === 0 ? '' : o.searching ? 'SEARCHING — stay out of sight' : 'WANTED';
    this.wantedBar.style.width = `${Math.round(o.cool * 100)}%`;
    if (o.money !== this.lastMoney) {
      this.lastMoney = o.money;
      this.moneyEl.textContent = `$${o.money.toLocaleString('en-US')}`;
    }
    // Active crimes.
    const rows = o.crimes
      .map((c) => {
        const d = Math.round(Math.hypot(c.x - o.px, c.z - o.pz));
        const m = Math.floor(c.left / 60);
        const s = Math.floor(c.left % 60);
        return `<div class="crow${c.left < 15 ? ' late' : ''}"><span class="ic">${c.icon}</span><span class="cl">${c.label}</span><span class="ct">${c.escape ? 'FLEEING' : `${m}:${String(s).padStart(2, '0')}`}</span><span class="cd">${d} m</span></div>`;
      })
      .join('');
    if (this.crimeList.innerHTML !== rows) this.crimeList.innerHTML = rows;
    // Ticker scroll.
    this.tickerOffset += dt * 70;
    const w = this.tickerText.offsetWidth + 400;
    if (this.tickerOffset > w) this.tickerOffset = 0;
    this.tickerText.style.transform = `translateX(${Math.round(window.innerWidth * 0.6 - this.tickerOffset)}px)`;
  }

  toggleRecord(force?: boolean): void {
    this.open = force ?? !this.open;
    this.record.style.display = this.open ? 'flex' : 'none';
  }

  /** Fill the record screen. */
  renderRecord(stats: Stats, territory: Territory): void {
    if (!this.open) return;
    const bar = (v: number, cls: string) => `<div class="rbar ${cls}"><i style="width:${Math.round(v)}%"></i></div>`;
    const outcomes = stats.outcomes;
    const types = CRIME_TYPES.map((t) => {
      const e = stats.byType.get(t);
      return `<tr><td>${CRIME_DEFS[t].name}</td><td>${e?.stopped ?? 0}</td><td>${e?.total ?? 0}</td></tr>`;
    }).join('');
    const control = CONTROL_DISTRICTS.map((d) => {
      const cells = GANG_IDS.map((g) => {
        const v = Math.round(territory.get(d, g));
        return `<td>${v > 0 ? `<span class="gc" style="--c:${GANGS[g].color}"><i style="width:${v}%"></i></span>${v}` : '<span class="muted">—</span>'}</td>`;
      }).join('');
      const own = territory.owner(d);
      return `<tr><td>${DISTRICT_NAMES[d as District]}</td>${cells}<td>${own ? `<b style="color:${GANGS[own].color}">${GANGS[own].short}</b>` : '<span class="muted">nobody</span>'}</td></tr>`;
    }).join('');
    this.recordBody.innerHTML = `
      <div class="rgrid">
        <div><small>Money</small><div class="big">$${stats.money.toLocaleString('en-US')}</div></div>
        <div><small>Crimes stopped</small><div class="big">${stats.crimesStopped}</div></div>
        <div><small>Criminals left for the police</small><div class="big">${stats.criminalsCaptured}</div></div>
        <div><small>Reputation</small>${bar(stats.reputation, 'rep')}<span>${Math.round(stats.reputation)} / 100</span></div>
        <div><small>Police Trust</small>${bar(stats.trust, 'trust')}<span>${Math.round(stats.trust)} / 100 · ${stats.trustLabel}</span></div>
        <div><small>Outcomes</small><span>stopped ${outcomes.stopped} · police ${outcomes.police} · failed ${outcomes.failed} · escaped ${outcomes.escaped}</span><br><span class="muted">busted ${stats.busted} · hospital ${stats.hospital}</span></div>
      </div>
      <h3>Gang control</h3>
      <table class="rtable"><tr><th>District</th>${GANG_IDS.map((g) => `<th style="color:${GANGS[g].color}">${GANGS[g].name}</th>`).join('')}<th>Holds it</th></tr>${control}</table>
      <h3>Crimes</h3>
      <table class="rtable small"><tr><th>Type</th><th>Stopped</th><th>Seen</th></tr>${types}</table>`;
  }
}
