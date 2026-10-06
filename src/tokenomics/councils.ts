import type { Controller } from './api';

/** Compare current deposited council owner addresses, never names or delegates. */
export function sameCouncilMembers(a: Controller, b: Controller): boolean {
  const left = new Set(a.members?.map(m => m.address)), right = new Set(b.members?.map(m => m.address));
  return a.type === 'council-realm' && b.type === 'council-realm' && left.size > 0 && left.size === right.size && [...left].every(address => right.has(address));
}
