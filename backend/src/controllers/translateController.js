import { AppError } from '../middleware/errorHandler.js';
import { success } from '../utils/response.js';
import { processMessage } from '../services/aiService.js';

export const translate = async (req, res, next) => {
  try {
    const { text, targetLanguage, sourceLanguage, sourceCode, targetCode } = req.body;
    if (!text || !targetLanguage) throw new AppError('Text and target language are required', 400);

    const targetHint = targetCode ? `${targetLanguage} (${targetCode})` : targetLanguage;
    const langHint = sourceLanguage ? (sourceCode ? ` from ${sourceLanguage} (${sourceCode})` : ` from ${sourceLanguage}`) : '';
    const response = await processMessage({
      messages: [
        { role: 'system', content: `You are a professional translator. Translate the following text${langHint} to ${targetHint}. Provide only the translation, nothing else.` },
        { role: 'user', content: text },
      ],
      mode: 'translate',
    });

    success(res, { translation: response.content, sourceLanguage, targetLanguage, sourceCode: sourceCode || null, targetCode: targetCode || null });
  } catch (err) {
    next(err);
  }
};
