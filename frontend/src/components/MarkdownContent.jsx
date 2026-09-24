import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { Copy, Check, Download } from 'lucide-react';
import { memo, useState } from 'react';

const CodeBlock = memo(function CodeBlock({ language, children }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = () => {
    navigator.clipboard.writeText(children);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleDownload = () => {
    const blob = new Blob([children], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `code.${language || 'txt'}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="code-block">
      <div className="code-header">
        <span>{language || 'code'}</span>
        <div style={{ display: 'flex', gap: 4 }}>
          <button onClick={handleCopy}>
            {copied ? <><Check size={11} /> Copied</> : <><Copy size={11} /> Copy</>}
          </button>
          <button onClick={handleDownload}>
            <Download size={11} /> Save
          </button>
        </div>
      </div>
      <SyntaxHighlighter
        style={oneDark}
        language={language || 'text'}
        PreTag="div"
        customStyle={{ margin: 0, background: 'var(--bg-primary)', fontSize: '12.5px', overflowX: 'auto' }}
      >
        {children}
      </SyntaxHighlighter>
    </div>
  );
});

const MarkdownContent = memo(function MarkdownContent({ content }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ node, inline, className, children, ...props }) {
          const match = /language-(\w+)/.exec(className || '');
          if (!inline && (match || String(children).includes('\n'))) {
            return <CodeBlock language={match?.[1]}>{String(children).replace(/\n$/, '')}</CodeBlock>;
          }
          return <code className={className} {...props}>{children}</code>;
        },
        table({ node, children, ...props }) {
          return (
            <div className="table-scroll">
              <table {...props}>{children}</table>
            </div>
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

export default MarkdownContent;