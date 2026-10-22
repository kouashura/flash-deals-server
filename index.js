const express = require('express');
const admin = require('firebase-admin');

// Initialisation Firebase Admin avec la variable d'environnement
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route appelée par PaiementPro
app.post('/creditWallet', async (req, res) => {
  try {
    const data = req.body;
    console.log('Notification PaiementPro:', JSON.stringify(data));

    if (data.responsecode !== '0') {
      return res.status(200).send('OK - Paiement échoué');
    }

    let userId = null;
    if (data.returnContext) {
      try {
        const context = JSON.parse(data.returnContext);
        userId = context.userId;
      } catch (e) {
        console.error('Erreur parsing returnContext:', e);
      }
    }

    if (!userId) return res.status(400).send('userId manquant');

    const txRef = admin.firestore()
      .collection('deals_wallets')
      .doc(userId)
      .collection('transactions')
      .doc(data.referenceNumber);

    const existingTx = await txRef.get();
    if (existingTx.exists) return res.status(200).send('Déjà traité');

    const amount = parseInt(data.amount, 10);
    const walletRef = admin.firestore().collection('deals_wallets').doc(userId);
    const walletDoc = await walletRef.get();
    const currentBalance = walletDoc.exists ? (walletDoc.data().balance || 0) : 0;

    await admin.firestore().runTransaction(async (transaction) => {
      transaction.set(walletRef, {
        balance: currentBalance + amount,
        currency: 'XOF',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      transaction.set(txRef, {
        id: data.referenceNumber,
        type: 'credit',
        amount: amount,
        description: 'Recharge PaiementPro',
        date: admin.firestore.FieldValue.serverTimestamp(),
        status: 'success',
      });
    });

    console.log(`✅ Wallet ${userId} crédité de ${amount} FCFA`);
    return res.status(200).send('OK - Wallet crédité');
  } catch (error) {
    console.error('Erreur creditWallet:', error);
    return res.status(500).send('Erreur serveur');
  }
});

app.get('/', (req, res) => res.send('Flash Deals Server is running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
