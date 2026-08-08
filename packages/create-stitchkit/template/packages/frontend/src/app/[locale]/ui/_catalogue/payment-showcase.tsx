'use client';

import { IconCheck, IconCreditCard } from '@tabler/icons-react';
import { useState } from 'react';
import {
  AdaptiveModal,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Field,
  Input,
} from '@/components/ui';

export function PaymentShowcase() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Card className='max-w-lg'>
        <CardHeader>
          <div className='flex items-center justify-between'>
            <div className='grid size-10 place-items-center rounded-xl bg-muted'>
              <IconCreditCard />
            </div>
            <Badge>Secure checkout</Badge>
          </div>
          <CardTitle className='pt-4 text-2xl'>Complete your order</CardTitle>
        </CardHeader>
        <CardContent className='space-y-5'>
          <div className='rounded-xl bg-muted p-4'>
            <div className='flex justify-between'>
              <span className='text-muted-foreground'>Product foundation</span>
              <span className='font-medium'>$99</span>
            </div>
          </div>
          <div className='space-y-2 text-sm'>
            {[
              'Typed contract surface',
              'Complete UI source',
              'Production deployment profiles',
            ].map((item) => (
              <div className='flex items-center gap-2' key={item}>
                <IconCheck className='text-success' size={17} />
                {item}
              </div>
            ))}
          </div>
          <Button className='w-full' variant='primary' onClick={() => setOpen(true)}>
            Continue to payment
          </Button>
          <p className='text-center text-xs text-muted-foreground'>
            Presentation only. Connect your own provider contract.
          </p>
        </CardContent>
      </Card>
      <AdaptiveModal
        isOpen={open}
        onClose={() => setOpen(false)}
        title='Checkout details'
        desktopWidth='md'
        mobileVariant='sheet'
        footer={
          <Button className='w-full' variant='primary' onClick={() => setOpen(false)}>
            Confirm example order
          </Button>
        }
      >
        <div className='grid gap-4 p-4 pt-1'>
          <Field label='Billing email' htmlFor='checkout-email'>
            <Input id='checkout-email' type='email' placeholder='builder@example.com' />
          </Field>
          <div className='flex justify-between rounded-xl bg-muted p-4 text-sm'>
            <span>Product foundation</span>
            <strong>$99</strong>
          </div>
        </div>
      </AdaptiveModal>
    </>
  );
}
