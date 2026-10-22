const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');

// Initialisation Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// Configuration DigitalPaye (REST API)
const DP_PUBLIC_KEY = process.env.DIGITALPAYE_PUBLIC_KEY;
const DP_SECRET = process.env.DIGITALPAYE_SECRET;
const DP_BASE_URL = 'https://api.digitalpaye.com/v1';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// ROUTE 1 : CRÉDIT DU WALLET (PaiementPro)
// ============================================================
app.post('/creditWallet', async (req, res) => {
  try {
    const data = req.body;
    if (data.responsecode !== '0') {
      return res.status(200).send('OK - Paiement échoué');
    }
    let userId = null;
    if (data.returnContext) {
      try { userId = JSON.parse(data.returnContext).userId; } catch (e) {}
    }
    if (!userId) return res.status(400).send('userId manquant');
    
    const txRef = admin.firestore().collection('deals_wallets').doc(userId).collection('transactions').doc(data.referenceNumber);
    const existingTx = await txRef.get();
    if (existingTx.exists) return res.status(200).send('Déjà traité');

    const amount = parseInt(data.amount, 10);
    const walletRef = admin.firestore().collection('deals_wallets').doc(userId);
    const walletDoc = await walletRef.get();
    const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;

    await admin.firestore().runTransaction(async (transaction) => {
      transaction.set(walletRef, { balance: currentBalance + amount, currency: 'XOF', updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      transaction.set(txRef, { id: data.referenceNumber, type: 'credit', amount, description: 'Recharge PaiementPro', date: admin.firestore.FieldValue.serverTimestamp(), status: 'success' });
    });
    return res.status(200).send('OK - Wallet crédité');
  } catch (error) {
    console.error('Erreur creditWallet:', error);
    return res.status(500).send('Erreur serveur');
  }
});

// ============================================================
// ROUTE 2 : RETRAIT DU WALLET (DigitalPaye REST)
// ============================================================
// Fonction pour obtenir un token DigitalPaye
async function getDigitalPayeToken() {
  const basicAuth = Buffer.from(`${DP_PUBLIC_KEY}:${DP_SECRET}`).toString('base64');
  const response = await axios.post(
    'https://api.digitalpaye.com/v1/auth/token',
    {},
    {
      headers: {
        'Authorization': `Basic ${basicAuth}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data.token || response.data.access_token;
}

app.post('/withdraw', async (req, res) => {
  const { userId, amount, phone, operator } = req.body;
  if (!userId || !amount || !phone || !operator) {
    return res.status(400).send('Parametres manquants');
  }

  try {
    const walletRef = admin.firestore().collection('deals_wallets').doc(userId);
    const walletDoc = await walletRef.get();
    if (!walletDoc.exists) return res.status(404).send('Wallet introuvable');

    const currentBalance = walletDoc.data().balance || 0;
    if (currentBalance < amount) return res.status(400).send('Solde insuffisant');

    const externalRef = `WITHDRAW_${Date.now()}`;

    // Utilisation du SDK DigitalPaye (auth automatique)
    const result = await dp.payouts.create({
      amount: amount,
      currency: 'XOF',
      operator_code: operator,
      external_ref: externalRef,
      recipient_phone: phone,
    });

    console.log('Reponse DigitalPaye:', JSON.stringify(result));

    const newBalance = currentBalance - amount;
    await walletRef.update({
      balance: newBalance,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    const txRef = walletRef.collection('transactions').doc();
    await txRef.set({
      id: txRef.id,
      type: 'debit',
      amount: amount,
      description: `Retrait vers ${operator}`,
      date: admin.firestore.FieldValue.serverTimestamp(),
      status: 'pending',
      externalRef: externalRef,
    });

    return res.status(200).send('Retrait initie avec succes');
  } catch (error) {
    console.error('Erreur withdraw:', error.message || error);
    return res.status(500).send('Erreur : ' + (error.message || 'Erreur inconnue'));
  }
});

app.post('/webhook/digitalpaye', async (req, res) => {
  try {
    const event = req.body;
    console.log('Webhook DigitalPaye:', JSON.stringify(event));
    const externalRef = event.data?.external_ref;
    const status = event.event === 'payout.success' ? 'success' : event.event === 'payout.failed' ? 'failed' : null;

    if (externalRef && status) {
      const wallets = await admin.firestore().collection('deals_wallets').get();
      for (const w of wallets.docs) {
        const q = await w.ref.collection('transactions').where('externalRef', '==', externalRef).get();
        if (!q.empty) { await q.docs[0].ref.update({ status }); break; }
      }
    }
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Erreur webhook:', error);
    return res.status(500).send('Erreur serveur');
  }
});

app.get('/', (req, res) => res.send('Flash Deals Server is running'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
