import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ArrowLeft, Plus, Users } from 'lucide-react';

import { groupsApi } from '@/shared/api';
import type { OrbitGroup, OrbitGroupSnapshot } from '@/shared/types';
import { CreateGroupForm } from '@/modules/groups/CreateGroupForm';
import { GroupWorkspace } from '@/modules/groups/GroupWorkspace';

/** Mounted by App at /groups and /groups/:groupId; owns polling and group navigation. */
export function GroupsPage() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  // Remote groups and the selected snapshot populate navigation and the current workspace.
  const [data, setData] = useState<{ groups: OrbitGroup[]; snapshot: OrbitGroupSnapshot | null }>({ groups: [], snapshot: null });
  // Creation is an explicit UI mode, independent of which existing group was last selected.
  const [creating, setCreating] = useState(false);
  // Poll failures stay visible while the last successful snapshot remains usable.
  const [error, setError] = useState('');
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const [groups, snapshot] = await Promise.all([groupsApi.list(signal), groupId ? groupsApi.read(groupId, signal) : Promise.resolve(null)]);
    if (!signal?.aborted) { setData({ groups, snapshot }); setError(''); }
  }, [groupId]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try { await refresh(controller.signal); }
      catch (failure) { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : String(failure)); }
      if (!controller.signal.aborted) timer = setTimeout(poll, 2500);
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [refresh]);

  return <div className="flex h-dvh flex-col overflow-hidden bg-background text-foreground">
    <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3"><Link to="/" className="flex items-center gap-2 text-sm text-muted-foreground"><ArrowLeft size={17} />Orbit</Link><span className="text-muted-foreground/40">/</span><Users size={18} /><strong className="text-sm">Groups</strong><button className="ml-auto flex items-center gap-1 rounded-lg bg-muted px-3 py-2 text-sm" onClick={() => setCreating(true)}><Plus size={16} />新建小组</button></header>
    <div className="flex min-h-0 flex-1 flex-col md:flex-row">
      <aside className="flex shrink-0 gap-2 overflow-auto border-b border-border p-3 md:w-56 md:flex-col md:border-b-0 md:border-r">{data.groups.map(group => <Link key={group.id} onClick={() => setCreating(false)} to={`/groups/${group.id}`} className={`shrink-0 rounded-lg px-3 py-2 text-sm ${group.id === groupId && !creating ? 'bg-muted font-medium' : 'hover:bg-muted/50'}`}>{group.name}</Link>)}{!data.groups.length && <p className="p-2 text-xs text-muted-foreground">创建你的小组，开始协作。</p>}</aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{error && <p role="alert" className="m-4 rounded-lg bg-red-500/10 p-3 text-sm text-red-500">{error}</p>}
        {creating ? <CreateGroupForm onCancel={() => setCreating(false)} onCreate={snapshot => { setCreating(false); navigate(`/groups/${snapshot.group.id}`); }} />
          : data.snapshot && data.snapshot.group.id === groupId ? <GroupWorkspace key={groupId} snapshot={data.snapshot} refresh={() => refresh()} />
          : <div className="mx-auto max-w-lg space-y-4 px-6 py-16"><Users className="text-muted-foreground" size={32} /><h1 className="text-2xl font-semibold">一起交流，一起推进。</h1><p className="text-sm leading-relaxed text-muted-foreground">把 2–5 个 agent 聚在一个 Group。发消息、发布关键信息、请求同伴协助；每次任务的分工由你来写。</p><button className="rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground" onClick={() => setCreating(true)}>创建第一个 Group</button></div>}
      </main>
    </div>
  </div>;
}
