import { ethers } from 'ethers';
import crypto from 'crypto';
import Wallet from '../models/WalletScheme.js';
import dotenv from 'dotenv';
dotenv.config();

// Get encryption key from environment variable and ensure it's 32 bytes
const ENCRYPTION_KEY = process.env.ENCRYPTION_KEY
// Convert the hex string to a 32-byte buffer
const ENCRYPTION_KEY_BUFFER = Buffer.from(ENCRYPTION_KEY.length === 64 ? ENCRYPTION_KEY : crypto.createHash('sha256').update(ENCRYPTION_KEY).digest('hex'), 'hex');

function encrypt(text) {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY_BUFFER, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + encrypted.toString('hex') + ':' + tag.toString('hex');
}

function decrypt(text) {
    const [ivHex, encryptedHex, tagHex] = text.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY_BUFFER, iv);
    decipher.setAuthTag(tag);
    return decipher.update(encrypted) + decipher.final('utf8');
}

export async function getOrCreateWallet(phoneNumber) {
    try {
        // Check if wallet exists for this phone number
        let wallet = await Wallet.findOne({ phoneNumber });
        
        if (wallet) {
            console.log('[Wallet] Found existing wallet for phone:', phoneNumber);
            return {
                address: wallet.address,
                privateKey: decrypt(wallet.encryptedPrivateKey)
            };
        }

        // Create new wallet if none exists
        const newWallet = ethers.Wallet.createRandom();
        console.log('[Wallet] Created new wallet for phone:', phoneNumber);

        // Save encrypted wallet info
        wallet = new Wallet({
            phoneNumber,
            address: newWallet.address,
            encryptedPrivateKey: encrypt(newWallet.privateKey)
        });
        await wallet.save();

        return {
            address: newWallet.address,
            privateKey: newWallet.privateKey
        };
    } catch (error) {
        console.error('[Wallet] Error managing wallet:', error);
        throw error;
    }
} 