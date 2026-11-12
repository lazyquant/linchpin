import { createRuleRegistry, parameters, type PredicateRole, type RuleKind } from '../../policy/index';
import { controllerResolved } from '../../policy/rules/controller';
import { unchangedSince } from '../../policy/rules/unchanged';
import { ID_PATTERN } from '../../policy/evaluate';
import { isPredicate, isTraversalRelation, VOCABULARY } from '../../engine/queries/vocabulary';
import { parseNearSubject } from '../reader/types';
import { bad, nearRootSubject, strings } from './params';
import { NO_LIBRARIES, type NearLibraries } from './libraries';
import { nearKinds } from './rules/near';
export const NEAR_TRAVERSAL_RELATIONS: readonly string[] = Object.freeze(['deployed-by', 'holds-role', 'legacy-oracle', 'owned-by', 'priced-by', 'routes-through', 'super-admin-of', 'upgraded-by']);
if (!NEAR_TRAVERSAL_RELATIONS.every(k => /^[a-z]/.test(k) && isTraversalRelation(k))) throw new Error('NEAR relation mismatch');
export function nearRoleOf(predicate: string): PredicateRole | undefined {
  if (!isPredicate(predicate)) return undefined;
  if (predicate === 'priced-by' || predicate === 'legacy-oracle') return 'oracle';
  const c = VOCABULARY[predicate].class;
  return c === 'control' || c === 'state' ? c : 'dependency';
}
export const nearUnchangedSince: RuleKind<{ snapshotId: string; factKeys: string[] }> = {
  kind: 'unchanged-since',
  parse(input) {
    const p = parameters(input, ['snapshotId', 'factKeys']);
    if (typeof p.snapshotId !== 'string' || !ID_PATTERN.test(p.snapshotId)) return bad();
    const factKeys = strings(p.factKeys, 64, v => {
      if (typeof v !== 'string') return bad();
      const [s, predicate, object, extra] = v.split('|');
      if (!s || !parseNearSubject(s) || !predicate || !/^[a-z]/.test(predicate) || !isPredicate(predicate) || extra !== undefined
        || (object !== undefined && (!object.length || /\s/.test(object))) || s.includes('#holder:')) return bad();
      return v;
    });
    return { snapshotId: p.snapshotId, factKeys };
  },
  evaluate: unchangedSince.evaluate,
};
export function createNearRegistry(libs: NearLibraries = NO_LIBRARIES) {
  return createRuleRegistry([
    { ...controllerResolved, parse(input) { const p = parameters(input, ['account']); return { account: nearRootSubject(p.account) }; } },
    nearUnchangedSince,
  ]).extend(nearKinds(libs));
}
export const NEAR_POLICY_KINDS: readonly string[] = Object.freeze(createNearRegistry().kinds());
