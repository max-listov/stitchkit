import { createGoogleOidcClient, type GoogleOidcIdentity } from 'stitchkit/google';

const identity: GoogleOidcIdentity = {
  subject: 'consumer-fixture',
  email: 'fixture@example.com',
};

void createGoogleOidcClient;
void identity;
