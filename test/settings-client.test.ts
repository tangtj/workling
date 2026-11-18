import { expect, test } from 'bun:test'
import { cardBody, syncDraft, type Card } from '../src/web/client/settings.ts'

test('各卡片草稿只转换对应请求字段', () => {
  const cases: [Card, Record<string, string>, Record<string, string | number | null>][] = [
    ['codex', { model: 'm', effort: 'high' }, { model: 'm', effort: 'high' }],
    [
      'git',
      { gitName: 'bot', gitEmail: 'bot@example.com' },
      { gitName: 'bot', gitEmail: 'bot@example.com' },
    ],
    [
      'pi',
      { piModel: '', llmBaseUrl: '', llmApi: 'openai-responses', llmApiKey: '' },
      { piModel: null, llmBaseUrl: null, llmApi: 'openai-responses' },
    ],
    [
      'pi',
      {
        piModel: 'm',
        llmBaseUrl: 'https://example.com',
        llmApi: 'openai-responses',
        llmApiKey: 'secret',
      },
      {
        piModel: 'm',
        llmBaseUrl: 'https://example.com',
        llmApi: 'openai-responses',
        llmApiKey: 'secret',
      },
    ],
    [
      'executor',
      {
        sandbox: 'none',
        concurrency: '3',
        taskCpus: '1.5',
        taskPids: '64',
        taskNetwork: '',
        taskImage: 'image',
        taskMemory: '4g',
      },
      {
        sandbox: 'none',
        concurrency: 3,
        taskCpus: 1.5,
        taskPids: 64,
        taskNetwork: null,
        taskImage: 'image',
        taskMemory: '4g',
      },
    ],
  ]
  for (const [card, draft, expected] of cases) expect(cardBody(card, draft)).toEqual(expected)
})

test('保存后未修改的卡片同步，修改中的卡片保留草稿', () => {
  for (const [draft, saved, expected] of [
    [{ value: 'old' }, false, { value: 'new' }],
    [{ value: 'edit' }, false, { value: 'edit' }],
    [{ value: 'edit' }, true, { value: 'new' }],
  ] as const)
    expect(syncDraft({ value: 'old' }, draft, { value: 'new' }, saved)).toEqual(expected)
})
