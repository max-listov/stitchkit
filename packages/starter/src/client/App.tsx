import { Link, Route, Switch, useLocation } from 'wouter';
import { HomePage } from './pages/home';

export function App() {
  const [location] = useLocation();

  return (
    <div className='flex flex-col h-full overflow-hidden'>
      <header className='flex items-center gap-3 px-5 py-2.5 border-b border-border shrink-0 bg-bg'>
        <Link
          to='/'
          className='text-[13px] font-semibold tracking-tight hover:text-accent transition-colors'
        >
          My App
        </Link>
        <div className='flex-1' />
        <span className='text-[10px] text-text-muted font-mono'>{location}</span>
      </header>

      <main className='flex-1 overflow-y-auto'>
        <Switch>
          <Route path='/' component={HomePage} />
          <Route>
            <div className='flex items-center justify-center h-full text-text-muted'>
              <p>404 — not found</p>
            </div>
          </Route>
        </Switch>
      </main>

      <footer className='flex items-center px-5 py-2 border-t border-border shrink-0 bg-bg'>
        <span className='text-[10px] text-text-muted font-mono'>stitchkit</span>
      </footer>
    </div>
  );
}

export default App;
