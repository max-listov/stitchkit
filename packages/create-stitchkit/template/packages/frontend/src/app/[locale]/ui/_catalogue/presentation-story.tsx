import { LanguageSwitcher, ThemeToggle } from '@/components/system-controls';
import { Button } from '@/components/ui';
import { AccountShowcase } from './account-showcase';
import { AdminShowcase } from './admin-showcase';
import { StorySection } from './catalogue-shell';
import { CodeFoundationSection } from './code-foundation';
import { ImagePreloader } from './image-preloader';
import {
  AudienceSection,
  BuilderSection,
  DemoModal,
  FrontendSection,
  LearningSection,
  ProblemsSection,
  TemplatePreviewSection,
  WhySection,
} from './landing-sections';
import {
  FeatureGrid,
  HeroSection,
  LandingFooter,
  LandingHeader,
  PortfolioSection,
  PricingSection,
} from './landing-showcase';
import { PaymentShowcase } from './payment-showcase';

export function BlocksStory() {
  return (
    <div>
      <StorySection title='Editorial landing system'>
        <LandingHeader
          actions={
            <>
              <LanguageSwitcher />
              <ThemeToggle />
              <Button size='sm'>Open app</Button>
            </>
          }
        />
        <HeroSection />
        <ProblemsSection />
        <BuilderSection />
        <WhySection />
        <CodeFoundationSection />
        <FeatureGrid />
        <AudienceSection />
        <LearningSection />
        <TemplatePreviewSection />
        <FrontendSection />
        <PortfolioSection />
        <PricingSection />
        <DemoModal />
        <LandingFooter />
        <ImagePreloader sources={['/theme-light.svg', '/theme-dark.svg']} />
      </StorySection>
      <StorySection title='Application shell'>
        <AdminShowcase />
      </StorySection>
      <StorySection title='Account flows'>
        <AccountShowcase />
      </StorySection>
      <StorySection title='Checkout presentation'>
        <PaymentShowcase />
      </StorySection>
    </div>
  );
}
