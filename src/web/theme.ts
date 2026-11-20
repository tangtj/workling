// 在样式加载前应用偏好，避免首屏闪烁。
export const themeScript =
  "(function(){try{var t=localStorage.getItem('workling-theme');if(t==='light'||t==='dark'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t}}catch(e){}})()"
