'use client';

import { IconCheck, IconMail } from '@tabler/icons-react';
import { ThemedImage } from '@wrksz/themes/client/themed-image';
import { useState } from 'react';
import { BrandMark } from '@/components/brand-mark';
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Checkbox,
  CopyableText,
  Field,
  HandDrawnCheck,
  HandDrawnX,
  Input,
  Label,
  OtpInput,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Slider,
  Spinner,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
  TriStateCheckbox,
  toast,
} from '@/components/ui';
import { StorySection } from './catalogue-shell';

type PrimitiveCategory = 'actions' | 'forms' | 'feedback' | 'media';

export function PrimitivesStory({ category }: { category: PrimitiveCategory }) {
  const [otp, setOtp] = useState('');
  const [enabled, setEnabled] = useState(true);

  return (
    <div>
      {category === 'actions' ? (
        <StorySection title='Actions and status'>
          <div className='flex flex-wrap gap-3'>
            <Button>default</Button>
            <Button variant='primary'>primary</Button>
            <Button variant='outline'>outline</Button>
            <Button variant='ghost'>ghost</Button>
            <Button variant='destructive'>destructive</Button>
            <Button loading>Working</Button>
            <Button size='icon' aria-label='Quick action'>
              <BrandMark className='size-5' />
            </Button>
          </div>
          <div className='flex flex-wrap gap-2'>
            <Badge icon={<IconCheck />}>default</Badge>
            <Badge icon={<IconCheck />} variant='primary'>
              primary
            </Badge>
            <Badge icon={<IconCheck />} variant='secondary'>
              secondary
            </Badge>
            <Badge icon={<IconCheck />} variant='outline'>
              outline
            </Badge>
            <Badge icon={<IconCheck />} variant='success'>
              success
            </Badge>
            <Badge icon={<IconCheck />} variant='warning'>
              warning
            </Badge>
            <Badge icon={<IconCheck />} variant='destructive'>
              destructive
            </Badge>
          </div>
        </StorySection>
      ) : null}

      {category === 'forms' ? (
        <StorySection title='Forms'>
          <Card className='w-full'>
            <CardHeader>
              <CardTitle>Project details</CardTitle>
              <CardDescription>Reusable accessible form primitives.</CardDescription>
            </CardHeader>
            <CardContent className='grid gap-4 sm:grid-cols-2'>
              <Field label='Project name' htmlFor='story-name'>
                <Input id='story-name' placeholder='Project atlas' />
              </Field>
              <Field label='Contact' htmlFor='story-email'>
                <Input id='story-email' type='email' placeholder='you@example.com' />
              </Field>
              <div className='sm:col-span-2'>
                <Field label='Description' htmlFor='story-description'>
                  <Textarea id='story-description' placeholder='What are you building?' />
                </Field>
              </div>
              <div className='space-y-2'>
                <Label htmlFor='story-select'>Stage</Label>
                <Select defaultValue='building'>
                  <SelectTrigger id='story-select'>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      <SelectLabel>Planning</SelectLabel>
                      <SelectItem value='idea'>Idea</SelectItem>
                    </SelectGroup>
                    <SelectSeparator />
                    <SelectGroup>
                      <SelectLabel>Delivery</SelectLabel>
                      <SelectItem value='building'>Building</SelectItem>
                      <SelectItem value='shipping'>Shipping</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </div>
              <div className='space-y-3'>
                <Label htmlFor='story-progress'>Progress</Label>
                <Slider
                  id='story-progress'
                  aria-label='Project progress'
                  defaultValue={[68]}
                  max={100}
                />
              </div>
              <Checkbox defaultChecked label='Public roadmap' />
              <div className='flex items-center gap-2 text-sm'>
                <Switch id='story-realtime' checked={enabled} onCheckedChange={setEnabled} />
                <Label htmlFor='story-realtime'>Realtime updates</Label>
              </div>
              <TriStateCheckbox checked='indeterminate' label='Select visible rows' />
            </CardContent>
          </Card>
        </StorySection>
      ) : null}

      {category === 'feedback' ? (
        <StorySection title='Identity, verification and feedback'>
          <div className='grid gap-6 md:grid-cols-2'>
            <Card>
              <CardContent className='flex items-center gap-4 pt-4'>
                <Avatar>
                  <AvatarImage src='https://github.com/github.png' alt='Example user avatar' />
                  <AvatarFallback>PB</AvatarFallback>
                </Avatar>
                <div>
                  <p className='font-medium'>Product builder</p>
                  <CopyableText value='builder@example.com'>
                    <span className='flex items-center gap-1'>
                      <IconMail size={14} /> builder@example.com
                    </span>
                  </CopyableText>
                </div>
              </CardContent>
            </Card>
            <Card>
              <CardContent className='pt-4 text-sm text-muted-foreground'>
                Card content
              </CardContent>
              <CardFooter>
                <Button
                  size='sm'
                  variant='outline'
                  onClick={() => toast.info('Project opened')}
                >
                  Open project
                </Button>
              </CardFooter>
            </Card>
            <Card>
              <CardContent className='space-y-4 pt-4'>
                <OtpInput value={otp} onChange={setOtp} />
                <div className='grid grid-cols-2 gap-2'>
                  <Button onClick={() => toast.success('Changes saved')}>Success toast</Button>
                  <Button variant='outline' onClick={() => toast.info('Sync is running')}>
                    Info toast
                  </Button>
                  <Button variant='outline' onClick={() => toast.warning('Review required')}>
                    Warning toast
                  </Button>
                  <Button variant='destructive' onClick={() => toast.error('Action failed')}>
                    Error toast
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
          <div className='flex items-center gap-5'>
            <HandDrawnCheck className='size-12 text-success' />
            <HandDrawnX className='size-12 text-destructive' />
            <Spinner />
            <Skeleton className='h-10 w-40' />
          </div>
        </StorySection>
      ) : null}

      {category === 'media' ? (
        <StorySection title='Tabs and theme-aware media'>
          <Tabs defaultValue='preview'>
            <TabsList>
              <TabsTrigger value='preview'>Preview</TabsTrigger>
              <TabsTrigger value='details'>Details</TabsTrigger>
            </TabsList>
            <TabsContent value='preview' className='pt-4'>
              <ThemedImage
                src={{ light: '/theme-light.svg', dark: '/theme-dark.svg' }}
                alt='Theme-aware application shell preview'
                width={640}
                height={360}
                className='w-full max-w-2xl rounded-2xl'
              />
            </TabsContent>
            <TabsContent value='details' className='pt-4 text-sm text-muted-foreground'>
              The same component switches assets with semantic theme state.
            </TabsContent>
          </Tabs>
        </StorySection>
      ) : null}
      {category === 'media' ? (
        <StorySection title='Semantic table primitives'>
          <div className='overflow-hidden rounded-xl border border-border'>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Surface</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>HTTP</TableCell>
                  <TableCell>Ready</TableCell>
                </TableRow>
                <TableRow>
                  <TableCell>MCP</TableCell>
                  <TableCell>Ready</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </StorySection>
      ) : null}
    </div>
  );
}
