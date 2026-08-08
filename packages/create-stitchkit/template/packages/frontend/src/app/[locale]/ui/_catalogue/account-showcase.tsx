'use client';

import { IconBrandGithub, IconDeviceLaptop, IconMail, IconUser } from '@tabler/icons-react';
import { useState } from 'react';
import {
  AdaptiveModal,
  Avatar,
  AvatarFallback,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
  OtpInput,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui';

export function AccountShowcase() {
  const [otp, setOtp] = useState('');
  const [profileOpen, setProfileOpen] = useState(false);
  return (
    <div className='grid gap-4 lg:grid-cols-2'>
      <Card>
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
        </CardHeader>
        <CardContent className='grid gap-4'>
          <Field label='Email' htmlFor='catalogue-email'>
            <Input id='catalogue-email' type='email' placeholder='you@example.com' />
          </Field>
          <Button variant='primary'>
            <IconMail /> Continue with email
          </Button>
          <Button variant='outline'>
            <IconBrandGithub /> Continue with provider
          </Button>
          <OtpInput value={otp} onChange={setOtp} />
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div className='flex items-center gap-3'>
            <Avatar>
              <AvatarFallback>
                <IconUser />
              </AvatarFallback>
            </Avatar>
            <div>
              <CardTitle>Account workspace</CardTitle>
              <p className='text-sm text-muted-foreground'>
                Controlled presentation, no fake authentication
              </p>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue='profile'>
            <TabsList>
              <TabsTrigger value='profile'>Profile</TabsTrigger>
              <TabsTrigger value='sessions'>Sessions</TabsTrigger>
            </TabsList>
            <TabsContent className='space-y-3 pt-4' value='profile'>
              <Field label='Display name' htmlFor='display-name'>
                <Input id='display-name' defaultValue='Product builder' />
              </Field>
              <Button onClick={() => setProfileOpen(true)}>Edit profile</Button>
            </TabsContent>
            <TabsContent className='pt-4' value='sessions'>
              <div className='flex items-center justify-between rounded-xl border border-border p-3'>
                <div className='flex items-center gap-3'>
                  <IconDeviceLaptop />
                  <div>
                    <p className='text-sm font-medium'>Current browser</p>
                    <p className='text-xs text-muted-foreground'>Active now</p>
                  </div>
                </div>
                <Badge variant='success'>Current</Badge>
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
      <AdaptiveModal
        isOpen={profileOpen}
        onClose={() => setProfileOpen(false)}
        title='Edit profile'
        desktopWidth='sm'
        mobileVariant='sheet'
        footer={
          <Button className='w-full' onClick={() => setProfileOpen(false)}>
            Save changes
          </Button>
        }
      >
        <div className='grid gap-4 p-4 pt-1'>
          <Field label='Display name' htmlFor='profile-modal-name'>
            <Input id='profile-modal-name' defaultValue='Product builder' />
          </Field>
          <Field label='Email' htmlFor='profile-modal-email'>
            <Input id='profile-modal-email' type='email' defaultValue='builder@example.com' />
          </Field>
        </div>
      </AdaptiveModal>
    </div>
  );
}
