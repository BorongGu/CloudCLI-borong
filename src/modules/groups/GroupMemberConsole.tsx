import { useMemo } from 'react';
import { Link } from 'react-router-dom';

import { ChatInterface } from '@/modules/chat';
import { useWebSocket } from '@/shared/context/WebSocketContext';
import type { OrbitGroupSnapshot, Project, ProjectSession } from '@/shared/types';

/** GroupsPage renders member transcripts and approvals inside the group console. */
export function GroupMemberConsole({ snapshot, memberId, onFileOpen }: { snapshot: OrbitGroupSnapshot; memberId: string; onFileOpen?: (file: string) => void }) {
  const member = snapshot.members.find(item => item.id === memberId);
  const { ws, sendMessage } = useWebSocket();
  const projectId = snapshot.project?.projectId || snapshot.group.id;
  const project = useMemo<Project>(() => ({ projectId, displayName: snapshot.group.name, fullPath: snapshot.group.projectPath }),
    [projectId, snapshot.group.name, snapshot.group.projectPath]);
  const sessionId = member?.sessionId; const name = member?.name; const provider = member?.provider;
  const session = useMemo<ProjectSession | null>(() => sessionId && provider ? { id: sessionId, summary: name,
    provider, __provider: provider, __projectId: projectId } : null,
  [sessionId, name, provider, projectId]);

  if (!member) return <p className="p-6 text-sm text-muted-foreground">请从小组中选择一位成员。</p>;
  return <div className="flex h-full min-h-0 flex-col">
    <header className="shrink-0 space-y-3 border-b border-border p-4">
      <div className="flex items-center justify-between gap-3"><strong>{snapshot.group.name} · 成员控制台</strong><Link to={`/groups/${snapshot.group.id}`} className="text-sm text-primary">返回公开讨论</Link></div>
      <nav className="flex flex-wrap gap-2">{snapshot.members.map(item => <Link key={item.id} to={`/groups/${snapshot.group.id}/members/${item.id}`} className={`rounded-lg px-3 py-2 text-sm ${item.id === memberId ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/50'}`}>{item.name} · {item.provider}</Link>)}</nav>
      <p className="text-xs text-muted-foreground">完整执行记录、工具结果与授权交互。讨论和任务更新集中在公共讨论区。</p>
    </header>
    <div className="min-h-0 flex-1"><ChatInterface key={member.sessionId} consoleOnly isActive selectedProject={project} selectedSession={session} ws={ws} sendMessage={sendMessage} onFileOpen={onFileOpen} showRawParameters showThinking /></div>
  </div>;
}
