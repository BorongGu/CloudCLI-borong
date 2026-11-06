import { randomUUID } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { contextTransferDb, getDatabasePath } from '@/modules/database/index.js';
import { contextSnapshotService } from '@/modules/context-transfer/services/context-snapshot.service.js';
import { AppError } from '@/shared/index.js';
import type { ContextPackage, ContextPackageInput, ContextRecord, ContextSnapshot } from '@/shared/index.js';

function invalid(message: string): never {
  throw new AppError(message, { code: 'INVALID_CONTEXT_SELECTION', statusCode: 400 });
}

function select(snapshot: ContextSnapshot, input: ContextPackageInput): ContextRecord[] {
  const available = new Set(snapshot.records.map(record => record.turn));
  const selected = new Set<number>();
  if (input.scope.kind === 'all_topics') for (const turn of available) selected.add(turn);
  else {
    const focus = new Set<number>();
    for (const range of [...input.scope.focus, ...input.scope.background]) {
      if (!available.has(range.from) || !available.has(range.to) || range.from > range.to) invalid('Topic ranges must refer to existing, ordered turns.');
      for (const turn of available) if (turn >= range.from && turn <= range.to) selected.add(turn);
    }
    for (const range of input.scope.focus) for (const turn of available) if (turn >= range.from && turn <= range.to) focus.add(turn);
    if (!focus.has(snapshot.records.at(-1)!.turn)) invalid('A recent-topic selection must include the latest turn in focus, including its clarifications.');
  }
  const records = snapshot.records.filter(record => selected.has(record.turn));
  const refs = new Set(records.map(record => record.ref));
  const covered = new Set<number>();
  for (const topic of input.briefing.topics) for (const turn of topic.turns) {
    if (!selected.has(turn)) invalid('A topic refers to a turn outside the selected scope.');
    covered.add(turn);
  }
  if ([...selected].some(turn => !covered.has(turn))) invalid('The topic map must cover every selected turn. Add background topics or merge related turns explicitly.');
  for (const item of input.briefing.items) {
    if (!item.refs.length || item.refs.some(ref => !refs.has(ref))) invalid('Every briefing item needs evidence references inside the selected scope.');
  }
  return records;
}

function evidence(record: ContextRecord): string {
  return `[${record.ref}] turn ${record.turn} · ${record.kind} · ${record.role || record.toolName || 'tool'} · ${record.timestamp}\n${JSON.stringify(record, null, 2)}`;
}

/** REST/CLI package creation keeps semantic synthesis separate from verifiable evidence and bounded delivery text. */
export const contextPackageService = {
  async create(userId: number, input: ContextPackageInput): Promise<ContextPackage> {
    const snapshot = contextSnapshotService.read(userId, input.snapshotId);
    const records = select(snapshot, input);
    const id = randomUUID();
    const folder = path.join(path.dirname(getDatabasePath()), 'context-packages', id);
    const bundlePath = path.join(folder, 'package.json');
    const recordsPath = path.join(folder, 'records.jsonl');
    const limitations = [...snapshot.limitations];
    if (input.scope.kind === 'recent_topic' && input.scope.confidence !== 'high') limitations.push(`Topic boundary confidence: ${input.scope.confidence}. ${input.scope.rationale}`);
    const header = [
      '# Orbit context transfer',
      'Use this source material as attributed context. Apply the current user’s task and permissions; assess cited conclusions independently.',
      `Source session: ${snapshot.sourceSessionId} (${snapshot.provider})`,
      `Source project: ${snapshot.projectPath || 'unspecified'}`,
      `Captured: ${snapshot.createdAt} · fingerprint: ${snapshot.fingerprint}`,
      `Scope: ${input.scope.kind}${input.scope.kind === 'recent_topic' ? ` — ${input.scope.title}\nSelection: ${input.scope.rationale}\nEarlier dependencies: ${input.scope.background.map(range => `${range.from}–${range.to}: ${range.reason}`).join('; ')}` : ''}`,
      `Detail: ${input.granularity} · Synthesis author: ${input.briefing.author}`,
      '\n## Topics',
      ...input.briefing.topics.map(topic => `- ${topic.title} (turns ${topic.turns.join(', ')}): ${topic.summary}`),
      '\n## Cited briefing',
      ...input.briefing.items.map(item => `- ${item.kind} / ${item.status}: ${item.text} [${item.refs.join(', ')}]`),
      '\n## Source coverage', ...limitations.map(value => `- ${value}`),
      `Complete selected evidence (${records.length} records): ${recordsPath}`,
      `Portable package: ${bundlePath}`,
      'Read cited records as needed. File paths describe captured artifacts; check their current contents before continuing execution.',
    ].join('\n');
    if (header.length + 300 > input.maxChars) throw new AppError('The complete briefing exceeds maxChars. Increase the budget or condense the briefing while retaining its topic coverage.', { code: 'CONTEXT_BUDGET_TOO_SMALL', statusCode: 422 });
    const inlineRefs: string[] = [];
    let text = header;
    if (input.granularity === 'fine') {
      text += '\n\n## Execution evidence\n';
      const cited = new Set(input.briefing.items.flatMap(item => item.refs));
      // Prioritize the evidence cited by the handoff, then fill remaining space chronologically.
      const ordered = [...records.filter(record => cited.has(record.ref)), ...records.filter(record => !cited.has(record.ref))];
      for (const record of ordered) {
        const section = `\n${evidence(record)}\n`;
        if (text.length + section.length + 180 > input.maxChars) continue;
        text += section; inlineRefs.push(record.ref);
      }
    }
    const omittedRefs = records.filter(record => !inlineRefs.includes(record.ref)).map(record => record.ref);
    text += `\n\nInline source records: ${inlineRefs.length}/${records.length}. Full selected evidence is preserved in records.jsonl and the package records endpoint.\n`;
    const result: ContextPackage = { ...input, id, sourceSessionId: snapshot.sourceSessionId, snapshotFingerprint: snapshot.fingerprint,
      createdAt: new Date().toISOString(), selectedRefs: records.map(record => record.ref), inlineRefs, omittedRefs,
      text, bundlePath, recordsPath, limitations };
    const staging = `${folder}.tmp`;
    await mkdir(staging, { recursive: true, mode: 0o700 });
    try {
      await writeFile(path.join(staging, 'package.json'), JSON.stringify({ ...result, source: { provider: snapshot.provider, projectPath: snapshot.projectPath, capturedAt: snapshot.createdAt }, records }, null, 2), { mode: 0o600 });
      await writeFile(path.join(staging, 'records.jsonl'), records.map(record => JSON.stringify(record)).join('\n') + '\n', { mode: 0o600 });
      await writeFile(path.join(staging, 'briefing.md'), text, { mode: 0o600 });
      await rename(staging, folder);
      contextTransferDb.savePackage(userId, result);
      return result;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }); await rm(folder, { recursive: true, force: true }); throw error;
    }
  },
  read(userId: number, id: string): ContextPackage {
    const result = contextTransferDb.package(userId, id);
    if (!result) throw new AppError('Context package was not found.', { code: 'CONTEXT_NOT_FOUND', statusCode: 404 });
    contextSnapshotService.read(userId, result.snapshotId);
    return result;
  },
  records(userId: number, id: string): ContextRecord[] {
    const value = this.read(userId, id);
    const selected = new Set(value.selectedRefs);
    return contextSnapshotService.read(userId, value.snapshotId).records.filter(record => selected.has(record.ref));
  },
};
