/**
 * The Nightwarden's standing in Port Vellmoor: money, reputation (0–100, how much the city
 * believes in the vigilante), Police Trust (0–100: below 30 officers treat the hero as a suspect at
 * crime scenes, above 60 they let him work) and a tally of crimes by outcome and type.
 */
import { events } from '../core/EventBus';

export type Outcome = 'stopped' | 'police' | 'failed' | 'escaped';

export class Stats {
  money = 1500;
  reputation = 10;
  trust = 40;
  crimesStopped = 0;
  criminalsCaptured = 0;
  readonly outcomes: Record<Outcome, number> = { stopped: 0, police: 0, failed: 0, escaped: 0 };
  readonly byType = new Map<string, { stopped: number; total: number }>();
  busted = 0;
  hospital = 0;

  change(o: { money?: number; reputation?: number; trust?: number }, reason: string): void {
    if (o.money) this.money = Math.max(0, Math.round(this.money + o.money));
    if (o.reputation) this.reputation = clamp(this.reputation + o.reputation);
    if (o.trust) this.trust = clamp(this.trust + o.trust);
    events.emit('stats:change', { money: this.money, reputation: this.reputation, trust: this.trust, reason });
  }

  crime(type: string, outcome: Outcome): void {
    this.outcomes[outcome]++;
    const e = this.byType.get(type) ?? { stopped: 0, total: 0 };
    e.total++;
    if (outcome === 'stopped') {
      e.stopped++;
      this.crimesStopped++;
    }
    this.byType.set(type, e);
  }

  get trustLabel(): string {
    return this.trust < 30 ? 'Suspect' : this.trust < 60 ? 'Tolerated' : 'Trusted';
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(100, v));
}
