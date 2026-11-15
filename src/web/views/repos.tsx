import type { PageData } from '../data.ts'
import { maskToken } from '../data.ts'
import { formatTime } from './format.ts'

import { count, labels } from './shared.tsx'

const notices: Record<string, string> = {
  added: '已添加仓库',
  deleted: '已删除仓库',
  token: '已更换 token',
  enabled: '已启用',
  disabled: '已停用',
}
export function ReposPage({ data, notice }: { data: PageData; notice: string }) {
  return (
    <>
      <header class="page-head">
        <div>
          <h1>仓库</h1>
          <p>
            {data.repos.length} 个仓库 · watch 只轮询已启用仓库中带 workling:ready 的 open Issue
          </p>
        </div>
        <button class="button button--primary" type="button" data-open="add-dialog">
          添加仓库
        </button>
      </header>
      {Object.hasOwn(notices, notice) && (
        <div class="notice">
          {notices[notice]}{' '}
          <button type="button" data-dismiss>
            关闭
          </button>
        </div>
      )}
      {data.repos.length ? (
        <div class="repo-cards">
          {data.repos.map((r) => (
            <article class={`card repo${r.enabled ? '' : ' off'}`}>
              <div class="repo-top">
                <div>
                  <a class="repo-name mono" href={`/repos/${r.id}`}>
                    {r.ref}
                  </a>
                  <p class="muted small">
                    {r.host} · token {maskToken(r.token)}
                    {!r.enabled && ' · 已停用'}
                  </p>
                </div>
                <button
                  type="button"
                  class="switch"
                  role="switch"
                  aria-label={`启用 ${r.ref}`}
                  aria-checked={r.enabled ? 'true' : 'false'}
                  data-repo-id={r.id}
                >
                  <span></span>
                </button>
              </div>
              <div class="counts">
                {(['running', 'queued', 'failed', 'done'] as const).map((status) => (
                  <div>
                    <small>{labels[status]}</small>
                    <b>
                      {count(
                        data.issues.filter((i) => i.repoId === r.id),
                        status,
                      )}
                    </b>
                  </div>
                ))}
              </div>
              <div class="repo-foot">
                <span>更新于 {formatTime(r.updatedAt, data.now)}</span>
                <div class="actions">
                  <button type="button" class="link-button" data-token-toggle={r.id}>
                    更换 token
                  </button>
                  <button
                    type="button"
                    class="link-button danger"
                    data-delete
                    data-repo-id={r.id}
                    data-ref={r.ref}
                  >
                    删除
                  </button>
                </div>
              </div>
              <form class="token-form row" data-repo-id={r.id} hidden id={`token-form-${r.id}`}>
                <input
                  name="token"
                  type="password"
                  required
                  placeholder="新 token"
                  aria-label="新 token"
                />
                <button class="button button--primary">保存</button>
                <button class="button" type="button" data-token-toggle={r.id}>
                  取消
                </button>
                <span class="error-text" role="alert"></span>
              </form>
            </article>
          ))}
        </div>
      ) : (
        <section class="card">
          <h2>添加第一个仓库</h2>
          <p>
            workling 会轮询带 <code>workling:ready</code> 标签的 open Issue，并在本机执行任务。
          </p>
          <ol class="steps">
            <li>
              <strong>01　准备 token</strong>
              <p>
                GitHub fine-grained token，授予目标仓库 Contents、Pull requests、Issues 读写权限。
              </p>
            </li>
            <li>
              <strong>02　添加仓库</strong>
              <p>保存后 token 只显示末 4 位，可随时更换或停用。</p>
            </li>
            <li>
              <strong>03　给 Issue 打标签</strong>
              <p>打上 workling:ready，下一轮轮询即入队执行。</p>
            </li>
          </ol>
        </section>
      )}
      <dialog id="add-dialog" class="drawer">
        <div class="drawer-head">
          <h2>添加仓库</h2>
          <button type="button" class="button" data-close>
            关闭
          </button>
        </div>
        <form id="add-form">
          <div class="drawer-body">
            <div id="add-error" class="error-box" role="alert" hidden></div>
            <label class="field">
              仓库引用
              <input name="ref" required placeholder="github:owner/repo" />
              <small>格式 github:owner/repo</small>
            </label>
            <label class="field">
              Token
              <input name="token" type="password" required autocomplete="off" />
              <small>保存后只显示末 4 位，可随时更换</small>
            </label>
            <div class="perm">
              <strong>Token 所需权限</strong>
              <p>Contents 读写 — push 分支</p>
              <p>Pull requests 读写 — 创建 PR</p>
              <p>Issues 读写 — 改标签、评论</p>
            </div>
            <label class="checkbox">
              <input name="enabled" type="checkbox" checked /> 添加后立即启用
            </label>
          </div>
          <div class="drawer-foot">
            <button type="button" class="button" data-close>
              取消
            </button>
            <button class="button button--primary" type="submit">
              添加仓库
            </button>
          </div>
        </form>
      </dialog>
      <p class="muted">暂只支持 GitHub；GitLab 后续接入。</p>
    </>
  )
}
