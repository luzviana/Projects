<#ftl output_format="plainText">
Welcome to ngenious

Hello ${(user.firstName)!"there"},

Your ngenious account is ready. Use this secure link to create your password and finish signing in:

${link}

This link expires in ${linkExpirationFormatter(linkExpiration)} and can be used only for this account setup.

If you were not expecting this message, you can safely ignore it.

Need help? Contact support@ngenious.ai

