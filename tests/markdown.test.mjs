import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown } from '../public/markdown.js';

const refs={references:id=>id==='S1'?'<button data-source="S1">[S1]</button>':null};

test('Markdown escapes model text before adding its own tags',()=>{
  const html=renderMarkdown('<script>alert(1)</script> <img src=x onerror="alert(1)"> "q" \'a\' & [x](javascript:alert(1)) [y](https://ok.example.gov/" onmouseover="alert(1))',refs);
  assert.ok(!/<script|<img|onerror="|href="javascript/i.test(html));assert.match(html,/&lt;script&gt;/);assert.match(html,/&quot;q&quot; &#39;a&#39; &amp;/);
  assert.ok(!/<a [^>]*onmouseover/.test(html));
  assert.equal(renderMarkdown('`<b>` **<i>x</i>**'),'<p><code>&lt;b&gt;</code> <strong>&lt;i&gt;x&lt;/i&gt;</strong></p>');
  // Placeholder characters in model text cannot pull in another token's HTML.
  assert.equal(renderMarkdown('\u00020\u0003 `code`'),'<p>0 <code>code</code></p>');
  assert.equal(renderMarkdown('[S2] stays text, [S1] opens',refs),'<p>[S2] stays text, <button data-source="S1">[S1]</button> opens</p>');
});

test('Markdown renders headings, lists, tables, code, quotes and links',()=>{
  assert.equal(renderMarkdown('# Title\n## Sub\n###### Deep\n# Using C#'),'<h3>Title</h3><h4>Sub</h4><h6>Deep</h6><h3>Using C#</h3>');
  assert.equal(renderMarkdown('1. First\n   - a\n   - b\n2. Second\n\n- one\n\n- two'),'<ol><li>First<ul><li>a</li><li>b</li></ul></li><li>Second</li></ol><ul><li>one</li><li>two</li></ul>');
  assert.equal(renderMarkdown('3. Third\n4. Fourth'),'<ol start="3"><li>Third</li><li>Fourth</li></ol>');
  assert.equal(renderMarkdown('Adopted in\n2024. The code applies.'),'<p>Adopted in<br>2024. The code applies.</p>');
  const table=renderMarkdown('| Standard | Edition | Source |\n| --- | :---: | ---: |\n| NFPA 13 | 2022 | [S1] |\n| NFPA 72 \\| alt | `a|b` |',refs);
  assert.equal(table,'<div class="chat-table"><table><thead><tr><th>Standard</th><th class="align-center">Edition</th><th class="align-right">Source</th></tr></thead><tbody><tr><td>NFPA 13</td><td class="align-center">2022</td><td class="align-right"><button data-source="S1">[S1]</button></td></tr><tr><td>NFPA 72 | alt</td><td class="align-center"><code>a|b</code></td><td class="align-right"></td></tr></tbody></table></div>');
  assert.equal(renderMarkdown('a | b\n--- | ---'),'<div class="chat-table"><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody></tbody></table></div>');
  assert.equal(renderMarkdown('a | b\n---'),'<p>a | b</p><hr>');
  assert.equal(renderMarkdown('```js\nconst x = "<b>";\n**not bold**\n```'),'<pre><code>const x = &quot;&lt;b&gt;&quot;;\n**not bold**</code></pre>');
  assert.equal(renderMarkdown('> quoted **bold**\n\n---\n*it* _em_ snake_case_name 5 * 3 * 2 ~~old~~'),'<blockquote><p>quoted <strong>bold</strong></p></blockquote><hr><p><em>it</em> <em>em</em> snake_case_name 5 * 3 * 2 <del>old</del></p>');
  assert.equal(renderMarkdown('See [the code](https://county.example.gov/a_b?x=1&y=2) or https://county.example.gov/fire.'),'<p>See <a href="https://county.example.gov/a_b?x=1&amp;y=2" target="_blank" rel="noopener noreferrer">the code</a> or <a href="https://county.example.gov/fire" target="_blank" rel="noopener noreferrer">https://county.example.gov/fire</a>.</p>');
});

test('citation markers pass through, including after a table row',()=>{
  assert.equal(renderMarkdown('Claim.0\n\n| A | B |\n| - | - |\n| 1 | 2 |1'),'<p>Claim.0</p><div class="chat-table"><table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>1</td><td>21</td></tr></tbody></table></div>');
  // Unfinished streamed Markdown still renders as text.
  assert.equal(renderMarkdown('| Standard | Edition |\n| --'),'<p>| Standard | Edition |<br>| --</p>');
  assert.equal(renderMarkdown('```\nopen fence'),'<pre><code>open fence</code></pre>');
});
