import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  ApiError,
  listProjectMembers,
  removeProjectMember,
  saveProjectMember,
} from "../api";
import type { Project, ProjectMember } from "../types";
import { LinearIcon } from "./LinearIcon";

interface ProjectMembersProps {
  project: Project;
  onClose: () => void;
}

function messageFor(error: unknown) {
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "成员操作失败，请重试。";
}

export function ProjectMembers({ project, onClose }: ProjectMembersProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [members, setMembers] = useState<ProjectMember[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [userId, setUserId] = useState("");
  const [userName, setUserName] = useState("");
  const [role, setRole] = useState<ProjectMember["role"]>("member");

  useEffect(() => {
    dialogRef.current?.showModal();
    const controller = new AbortController();
    void listProjectMembers(project.id, controller.signal).then(setMembers, (nextError) => {
      if ((nextError as Error).name !== "AbortError") setError(messageFor(nextError));
    }).finally(() => setLoading(false));
    return () => controller.abort();
  }, [project.id]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!userId.trim() || !userName.trim()) return;
    setSaving(true);
    setError(null);
    try {
      const member = await saveProjectMember(project.id, {
        userId: userId.trim(),
        userName: userName.trim(),
        role,
      });
      setMembers((current) => [
        ...current.filter((candidate) => candidate.userId !== member.userId),
        member,
      ]);
      setUserId("");
      setUserName("");
      setRole("member");
    } catch (nextError) {
      setError(messageFor(nextError));
    } finally {
      setSaving(false);
    }
  }

  async function remove(member: ProjectMember) {
    setError(null);
    try {
      await removeProjectMember(project.id, member.userId);
      setMembers((current) => current.filter((candidate) => candidate.userId !== member.userId));
    } catch (nextError) {
      setError(messageFor(nextError));
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="task-dialog project-members-dialog"
      aria-labelledby="project-members-title"
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="task-form">
        <header className="dialog-header">
          <div className="dialog-context">
            <strong id="project-members-title">项目成员 · {project.name}</strong>
          </div>
          <button className="icon-button dialog-close" type="button" aria-label="关闭成员管理" onClick={onClose}>
            <LinearIcon name="close" />
          </button>
        </header>
        <div className="project-members-body">
          <p>员工使用企业微信 UserID 登录后，只能看到被加入的项目。</p>
          <form className="project-member-form" onSubmit={submit}>
            <label><span>企业微信 UserID</span><input value={userId} maxLength={96} onChange={(event) => setUserId(event.target.value)} placeholder="例如 ZhangSan" /></label>
            <label><span>姓名</span><input value={userName} maxLength={120} onChange={(event) => setUserName(event.target.value)} placeholder="员工姓名" /></label>
            <label><span>项目角色</span><select value={role} onChange={(event) => setRole(event.target.value as ProjectMember["role"])}><option value="member">成员</option><option value="manager">项目经理</option><option value="admin">项目管理员</option></select></label>
            <button className="button primary" type="submit" disabled={saving || !userId.trim() || !userName.trim()}>{saving ? "保存中…" : "添加或更新"}</button>
          </form>
          {error && <div className="attachments-error" role="alert">{error}</div>}
          {loading ? <p>正在读取成员…</p> : members.length === 0 ? <p>尚未添加项目成员。</p> : (
            <ul className="project-member-list">
              {members.map((member) => (
                <li key={member.userId}>
                  <div><strong>{member.userName}</strong><span>@{member.userId}</span></div>
                  <span>{member.role === "admin" ? "项目管理员" : member.role === "manager" ? "项目经理" : "成员"}</span>
                  <button className="button secondary" type="button" onClick={() => void remove(member)}>移除</button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </dialog>
  );
}
