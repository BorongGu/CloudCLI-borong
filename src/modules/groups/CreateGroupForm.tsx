import { useState } from 'react';
import { Plus, X } from 'lucide-react';

import { groupsApi } from '@/shared/api';
import type { LLMProvider, OrbitGroupCreateInput, OrbitGroupSnapshot } from '@/shared/types';
import { GroupModelPicker } from '@/modules/groups/GroupModelPicker';

const FIELD = 'w-full rounded-lg border border-border bg-background px-3 py-2 text-sm';

/** Used by GroupsPage to create dedicated member conversations without starting model calls. */
export function CreateGroupForm({ onCreate, onCancel }: { onCreate: (snapshot: OrbitGroupSnapshot) => void; onCancel: () => void }) {
  // The editable setup is retained until the user creates the group or closes the form.
  const [input, setInput] = useState<OrbitGroupCreateInput>({ name: '', projectPath: '', members: [
    { name: 'A', provider: 'claude', model: '' }, { name: 'B', provider: 'codex', model: '' }, { name: 'C', provider: 'opencode', model: '' },
  ] });
  // Submission state prevents duplicate group creation and displays recoverable API errors.
  const [submission, setSubmission] = useState({ busy: false, error: '' });
  const updateMember = (index: number, patch: Partial<OrbitGroupCreateInput['members'][number]>) =>
    setInput(old => ({ ...old, members: old.members.map((member, i) => i === index ? { ...member, ...patch } : member) }));

  return <form className="mx-auto w-full max-w-2xl space-y-5 p-5 md:p-8" onSubmit={async event => {
    event.preventDefault();
    setSubmission({ busy: true, error: '' });
    try { onCreate(await groupsApi.create(input)); }
    catch (error) { setSubmission({ busy: false, error: error instanceof Error ? error.message : String(error) }); }
  }}>
    <div><h1 className="text-xl font-semibold">创建 Group</h1><p className="mt-2 text-sm text-muted-foreground">选择 2–5 位成员，任务和分工可以在每次派发时填写。</p></div>
    <label className="block space-y-2"><span className="text-sm">小组名称</span><input required maxLength={100} className={FIELD} value={input.name} onChange={event => setInput(old => ({ ...old, name: event.target.value }))} placeholder="例如：一起想想" /></label>
    <label className="block space-y-2"><span className="text-sm">工作目录</span><input required className={FIELD} value={input.projectPath} onChange={event => setInput(old => ({ ...old, projectPath: event.target.value }))} placeholder="本机已有目录的完整路径" /></label>
    <div className="space-y-3">{input.members.map((member, index) => <fieldset key={index} className="rounded-xl border border-border p-3">
      <legend className="px-1 text-xs text-muted-foreground">成员 {index + 1}</legend>
      <div className="flex items-end gap-2">
        <label className="min-w-0 flex-1 space-y-1"><span className="text-xs">名字</span><input aria-label={`成员 ${index + 1} 名字`} required maxLength={48} className={FIELD} value={member.name} onChange={event => updateMember(index, { name: event.target.value })} /></label>
        <label className="min-w-0 flex-1 space-y-1"><span className="text-xs">Harness</span><select aria-label={`成员 ${index + 1} Harness`} className={FIELD} value={member.provider} onChange={event => updateMember(index, { provider: event.target.value as LLMProvider, model: '', effort: 'default' })}>
          <option value="claude">Claude Code</option><option value="codex">Codex</option><option value="cursor">Cursor</option><option value="opencode">OpenCode</option>
        </select></label>
        <button type="button" aria-label={`移除成员 ${index + 1}`} disabled={input.members.length <= 2} className="rounded-lg p-2 disabled:opacity-30" onClick={() => setInput(old => ({ ...old, members: old.members.filter((_, i) => i !== index) }))}><X size={18} /></button>
      </div>
      <div className="mt-3 space-y-1"><span className="text-xs">模型与推理强度</span><GroupModelPicker provider={member.provider} model={member.model} effort={member.effort} label={`成员 ${index + 1} 模型与推理强度`} onChange={(model, effort) => updateMember(index, { model, effort })} /></div>
      {member.provider === 'cursor' && <p className="mt-2 text-xs text-muted-foreground">Cursor 当前通过下一轮执行接收讨论消息。</p>}
      <label className="mt-3 block space-y-1"><span className="text-xs">执行权限</span><select aria-label={`成员 ${index + 1} 执行权限`} className={FIELD} value={member.permissionMode || 'default'} onChange={event => updateMember(index, { permissionMode: event.target.value as NonNullable<typeof member.permissionMode> })}><option value="default">标准权限 · 在成员会话处理授权</option><option value="acceptEdits">自动接受编辑</option><option value="bypassPermissions">完全访问</option></select></label>
    </fieldset>)}</div>
    <button type="button" disabled={input.members.length >= 5} className="flex items-center gap-2 text-sm disabled:opacity-30" onClick={() => setInput(old => ({ ...old, members: [...old.members, { name: '', provider: 'claude', model: '' }] }))}><Plus size={16} />添加成员</button>
    {submission.error && <p role="alert" className="text-sm text-red-500">{submission.error}</p>}
    <div className="flex gap-3"><button disabled={submission.busy} className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground disabled:opacity-50">{submission.busy ? '正在创建…' : '创建小组'}</button><button type="button" className="px-4 py-2 text-sm" onClick={onCancel}>返回</button></div>
  </form>;
}
