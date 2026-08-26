<#import "template.ftl" as layout>
<@layout.registrationLayout displayMessage=false; section>
  <#if section = "header">
    <#if requiredActions??>
      Set up your account
    <#elseif messageHeader??>
      ${kcSanitize(msg("${messageHeader}"))?no_esc}
    <#else>
      ${message.summary}
    </#if>
  <#elseif section = "form">
    <div id="kc-info-message">
      <#if requiredActions??>
        <p class="instruction ngenious-setup-instruction">Continue to verify your email and create a password.</p>
        <#if actionUri?has_content>
          <a id="ngenious-continue-setup" class="pf-v5-c-button pf-m-primary pf-m-block" href="${actionUri}">Continue</a>
        </#if>
      <#else>
        <p class="instruction">${message.summary}</p>
      </#if>
    </div>
  </#if>
</@layout.registrationLayout>
