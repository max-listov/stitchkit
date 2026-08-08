import type { StoryId } from '@/lib/seo/pages';
import { ComponentsStory } from './components-story';
import { BlocksStory } from './presentation-story';
import { ThemeStory } from './theme-story';

export function StoryPage({ story }: { story: StoryId }) {
  if (story === 'components') {
    return <ComponentsStory />;
  }
  if (story === 'themes') {
    return <ThemeStory />;
  }
  return <BlocksStory />;
}
