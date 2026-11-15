-- Passkeys added without a name of their own were stored with the interface's old wording for them; they read "Passkey".
UPDATE sign_in_methods SET label = 'Passkey' WHERE kind = 'passkey' AND label = 'Fingerprint, face or screen lock';
