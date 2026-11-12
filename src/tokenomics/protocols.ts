import type { ProtocolId } from './api';

export const PROTOCOL_IDS: readonly ProtocolId[] = ['marinade', 'kamino'];
export const isProtocolId = (id: string): id is ProtocolId => PROTOCOL_IDS.includes(id as ProtocolId);
export const NOT_MAPPED_PREFIX = 'Not mapped in this capture';
export type ProtocolView = {
  title: string; eyebrow: string; coverage: string | null; prompts: { label: string; question: string }[];
  placeholder: string; pathHeading: string; exportName: string;
};
export const PROTOCOL_VIEW: Record<ProtocolId, ProtocolView> = {
  marinade: {
    title: 'Marinade tokenomics', eyebrow: 'MARINADE / MNDE · TOKENOMICS DEPENDENCY GRAPH', coverage: null,
    prompts: [{ label: 'Who controls fees?', question: 'Who can change the fees?' }, { label: 'Is the path enforced?', question: 'Is the value path to MNDE holders enforced?' }, { label: 'What is missing?', question: 'What remains unresolved?' }],
    placeholder: 'Which authority controls the reward fee?', pathHeading: 'How activity can reach MNDE holders', exportName: 'linchpin-marinade-tokenomics.json',
  },
  kamino: {
    title: 'Kamino: Sentora PYUSD kVault', eyebrow: 'KAMINO / SENTORA PYUSD KVAULT · TOKENOMICS DEPENDENCY GRAPH',
    coverage: "Mapped from the recorded capture: who controls the vault, its lending markets and its programs (all four controlling accounts are of unresolved type); which reserves the vault allocates to, which market each reserve is in and which oracle prices it; the vault's fee and withdrawal parameters and each reserve's protocol take rate; and one documentation claim checked against the chain. Not mapped: where fees go, the treasury, KMNO supply and mint control, governance, holders and transaction flows.",
    prompts: ["Who can change the vault's allocations?", 'What does the vault depend on?', 'What fees does the vault charge?'].map(question => ({ label: question, question })),
    placeholder: "Which account can change the vault's allocations?", pathHeading: 'Where value routes', exportName: 'linchpin-kamino-tokenomics.json',
  },
};
