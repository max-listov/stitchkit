import { Button } from '@client/components/ui/Button';
import { EmptyState } from '@client/components/ui/EmptyState';
import { Input, Textarea } from '@client/components/ui/Input';
import { Skeleton } from '@client/components/ui/Skeleton';
import { useNotes } from '@client/hooks/useNotes';
import { NotebookPen, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';

export function HomePage() {
  const { notes, loading, create, remove } = useNotes();
  const [title, setTitle] = useState('');
  const [content, setContent] = useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    create({ title: title.trim(), content: content.trim() });
    setTitle('');
    setContent('');
  };

  return (
    <div className='max-w-2xl mx-auto space-y-8 px-8 py-6'>
      <div>
        <h2 className='text-xl font-semibold tracking-tight mb-1'>Notes</h2>
        <p className='text-sm text-text-muted'>
          Create, read, delete. Data persists to disk. WebSocket live-reload.
        </p>
      </div>

      <form
        onSubmit={handleSubmit}
        className='flex flex-col gap-3 p-4 border border-border bg-bg-elevated rounded-lg'
      >
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder='Title' />
        <Textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder='Content (optional)'
          rows={3}
        />
        <Button type='submit' disabled={!title.trim()} size='sm' className='self-start'>
          <Plus size={14} strokeWidth={2.5} />
          Add Note
        </Button>
      </form>

      {loading ? (
        <div className='space-y-3'>
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className='h-20' />
          ))}
        </div>
      ) : notes.length === 0 ? (
        <EmptyState icon={<NotebookPen size={32} />} title='No notes yet' />
      ) : (
        <div className='space-y-2'>
          {notes.map((note) => (
            <div
              key={note.id}
              className='flex items-start gap-3 p-4 border border-border bg-bg-elevated rounded-lg hover:border-border-hover transition-colors group'
            >
              <div className='flex-1 min-w-0'>
                <div className='flex items-center gap-2 mb-1'>
                  <h3 className='text-[13px] font-semibold truncate'>{note.title}</h3>
                  <span className='text-[10px] text-text-dim font-mono shrink-0'>
                    {new Date(note.createdAt).toLocaleDateString('en-GB')}
                  </span>
                </div>
                {note.content ? (
                  <p className='text-[12px] text-text-muted line-clamp-2'>{note.content}</p>
                ) : null}
              </div>
              <button
                type='button'
                onClick={() => remove(note.id)}
                className='opacity-0 group-hover:opacity-100 p-1 text-text-dim hover:text-danger transition-all cursor-pointer'
              >
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
