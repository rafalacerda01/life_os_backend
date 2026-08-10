[1mdiff --git a/package-lock.json b/package-lock.json[m
[1mindex bc5803a..f4225e2 100644[m
[1m--- a/package-lock.json[m
[1m+++ b/package-lock.json[m
[36m@@ -11,172 +11,155 @@[m
       "dependencies": {[m
         "cors": "^2.8.6",[m
         "express": "^5.2.1",[m
[31m-        "firebase-admin": "^11.11.1"[m
[32m+[m[32m        "firebase-admin": "^14.2.0"[m
       },[m
       "engines": {[m
         "node": "24.x"[m
       }[m
     },[m
[31m-    "node_modules/@babel/helper-string-parser": {[m
[31m-      "version": "7.29.7",[m
[31m-      "resolved": "https://registry.npmjs.org/@babel/helper-string-parser/-/helper-string-parser-7.29.7.tgz",[m
[31m-      "integrity": "sha512-Pb5ijPrZ89GDH8223L4UP8i6QApWxs04RbPQJTeWDV0/keR2E36MeKnyr6LYmUUvqRRI+Iv87SuF1W6ErINzYw==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=6.9.0"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/@babel/helper-validator-identifier": {[m
[31m-      "version": "7.29.7",[m
[31m-      "resolved": "https://registry.npmjs.org/@babel/helper-validator-identifier/-/helper-validator-identifier-7.29.7.tgz",[m
[31m-      "integrity": "sha512-qehxGkRj55h/ff8EMaJ+cYhyaKlHIxqYDn682wQD7RNp9UujOQsHog2uS0r2vzr4pW+sXf90NeeayjcNaX3fFg==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=6.9.0"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/@babel/parser": {[m
[31m-      "version": "7.29.7",[m
[31m-      "resolved": "https://registry.npmjs.org/@babel/parser/-/parser-7.29.7.tgz",[m
[31m-      "integrity": "sha512-hnORnjP/1P/zFEndoeX+n+t1RwWRJiJpM/jO7FW32Kn9r5+sJB2JWOdYo4L6k78j15eCwY3Gm/7364B1EMwtNg==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "@babel/types": "^7.29.7"[m
[31m-      },[m
[31m-      "bin": {[m
[31m-        "parser": "bin/babel-parser.js"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=6.0.0"[m
[31m-      }[m
[32m+[m[32m    "node_modules/@fastify/busboy": {[m
[32m+[m[32m      "version": "3.2.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@fastify/busboy/-/busboy-3.2.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-m9FVDXU3GT2ITSe0UaMA5rU3QkfC/UXtCU8y0gSN/GugTqtVldOBWIB5V6V3sbmenVZUIpU6f+mPEO2+m5iTaA==",[m
[32m+[m[32m      "license": "MIT"[m
     },[m
[31m-    "node_modules/@babel/types": {[m
[31m-      "version": "7.29.7",[m
[31m-      "resolved": "https://registry.npmjs.org/@babel/types/-/types-7.29.7.tgz",[m
[31m-      "integrity": "sha512-4zBIxpPzowiZpusoFkyGVwakdRJUyuH5PxQ/PrqghfdFWWasvnCdPfQXHrenDai+gyLARulZjZowCOj6fjT4pA==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "@babel/helper-string-parser": "^7.29.7",[m
[31m-        "@babel/helper-validator-identifier": "^7.29.7"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=6.9.0"[m
[31m-      }[m
[32m+[m[32m    "node_modules/@firebase/app-check-interop-types": {[m
[32m+[m[32m      "version": "0.3.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/app-check-interop-types/-/app-check-interop-types-0.3.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-zz3i6e13B8BfWiLy8MABtTh8aGIACgKbf9UVnyHcWs+yQzJXgQcl8A46b0zfaiJHdQ+niF0ouAfcpuf+3LMPQg==",[m
[32m+[m[32m      "license": "Apache-2.0"[m
     },[m
[31m-    "node_modules/@fastify/busboy": {[m
[31m-      "version": "1.2.1",[m
[31m-      "resolved": "https://registry.npmjs.org/@fastify/busboy/-/busboy-1.2.1.tgz",[m
[31m-      "integrity": "sha512-7PQA7EH43S0CxcOa9OeAnaeA0oQ+e/DHNPZwSQM9CQHW76jle5+OvLdibRp/Aafs9KXbLhxyjOTkRjWUbQEd3Q==",[m
[31m-      "license": "MIT",[m
[32m+[m[32m    "node_modules/@firebase/app-types": {[m
[32m+[m[32m      "version": "0.9.5",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/app-types/-/app-types-0.9.5.tgz",[m
[32m+[m[32m      "integrity": "sha512-YevqTjvo7Iujsa9Dwowmd6dSoElhzmD63ZSrq6bzjvQ6POjYgNjOFHLmNIgJs48eNO093NCERibuFnxbfOvU7A==",[m
[32m+[m[32m      "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "text-decoding": "^1.0.0"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=14"[m
[32m+[m[32m        "@firebase/logger": "0.5.1"[m
       }[m
     },[m
[31m-    "node_modules/@firebase/app-types": {[m
[31m-      "version": "0.9.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/app-types/-/app-types-0.9.0.tgz",[m
[31m-      "integrity": "sha512-AeweANOIo0Mb8GiYm3xhTEBVCmPwTYAu9Hcd2qSkLuga/6+j9b1Jskl5bpiSQWy9eJ/j5pavxj6eYogmnuzm+Q==",[m
[31m-      "license": "Apache-2.0"[m
[31m-    },[m
     "node_modules/@firebase/auth-interop-types": {[m
[31m-      "version": "0.2.1",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/auth-interop-types/-/auth-interop-types-0.2.1.tgz",[m
[31m-      "integrity": "sha512-VOaGzKp65MY6P5FI84TfYKBXEPi6LmOCSMMzys6o2BN2LOsqy7pCuZCup7NYnfbk5OkkQKzvIfHOzTm0UDpkyg==",[m
[32m+[m[32m      "version": "0.2.5",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/auth-interop-types/-/auth-interop-types-0.2.5.tgz",[m
[32m+[m[32m      "integrity": "sha512-1Li/YuBDBAXcKv7BzY4U28gontUmAaw53sYiqbaVOMCFb2lFKK/c3CGMUWqtwe7+TXrl3poWnTCL5umYBg85Eg==",[m
       "license": "Apache-2.0"[m
     },[m
     "node_modules/@firebase/component": {[m
[31m-      "version": "0.6.4",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/component/-/component-0.6.4.tgz",[m
[31m-      "integrity": "sha512-rLMyrXuO9jcAUCaQXCMjCMUsWrba5fzHlNK24xz5j2W6A/SRmK8mZJ/hn7V0fViLbxC0lPMtrK1eYzk6Fg03jA==",[m
[32m+[m[32m      "version": "0.7.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/component/-/component-0.7.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-tLpOaaCol9ugUIYp2R3CbWPPA8Ajg/papX/XHEy8U52b/QXH3BbX8tTJX9aShDCjp+9sMAxMLD94i7lresdugQ==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "@firebase/util": "1.9.3",[m
[32m+[m[32m        "@firebase/util": "1.15.2",[m
         "tslib": "^2.1.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=20.0.0"[m
       }[m
     },[m
     "node_modules/@firebase/database": {[m
[31m-      "version": "0.14.4",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/database/-/database-0.14.4.tgz",[m
[31m-      "integrity": "sha512-+Ea/IKGwh42jwdjCyzTmeZeLM3oy1h0mFPsTy6OqCWzcu/KFqRAr5Tt1HRCOBlNOdbh84JPZC47WLU18n2VbxQ==",[m
[32m+[m[32m      "version": "1.1.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/database/-/database-1.1.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-D+j4+8uhGtNd1tVD+X+c8JrC4ppStGJKyujSQt2NPwdN26QcCk0BeIxue+UqspHkHiFHyQOimwlzjLewGq6S+A==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "@firebase/auth-interop-types": "0.2.1",[m
[31m-        "@firebase/component": "0.6.4",[m
[31m-        "@firebase/logger": "0.4.0",[m
[31m-        "@firebase/util": "1.9.3",[m
[32m+[m[32m        "@firebase/app-check-interop-types": "0.3.4",[m
[32m+[m[32m        "@firebase/auth-interop-types": "0.2.5",[m
[32m+[m[32m        "@firebase/component": "0.7.4",[m
[32m+[m[32m        "@firebase/logger": "0.5.1",[m
[32m+[m[32m        "@firebase/util": "1.15.2",[m
         "faye-websocket": "0.11.4",[m
         "tslib": "^2.1.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=20.0.0"[m
       }[m
     },[m
     "node_modules/@firebase/database-compat": {[m
[31m-      "version": "0.3.4",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/database-compat/-/database-compat-0.3.4.tgz",[m
[31m-      "integrity": "sha512-kuAW+l+sLMUKBThnvxvUZ+Q1ZrF/vFJ58iUY9kAcbX48U03nVzIF6Tmkf0p3WVQwMqiXguSgtOPIB6ZCeF+5Gg==",[m
[32m+[m[32m      "version": "2.1.6",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/database-compat/-/database-compat-2.1.6.tgz",[m
[32m+[m[32m      "integrity": "sha512-mu7S/75UIajB1A5M9Vfojk69LttW55uABp9nHEtWrV/mIaSEwvoaIe9GySsEzS2EKFK5/3f5okcAuUbihhYeJg==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "@firebase/component": "0.6.4",[m
[31m-        "@firebase/database": "0.14.4",[m
[31m-        "@firebase/database-types": "0.10.4",[m
[31m-        "@firebase/logger": "0.4.0",[m
[31m-        "@firebase/util": "1.9.3",[m
[32m+[m[32m        "@firebase/component": "0.7.4",[m
[32m+[m[32m        "@firebase/database": "1.1.4",[m
[32m+[m[32m        "@firebase/database-types": "1.0.21",[m
[32m+[m[32m        "@firebase/logger": "0.5.1",[m
[32m+[m[32m        "@firebase/util": "1.15.2",[m
         "tslib": "^2.1.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=20.0.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "peerDependencies": {[m
[32m+[m[32m        "@firebase/app": "0.x",[m
[32m+[m[32m        "@firebase/app-compat": "0.x"[m
[32m+[m[32m      },[m
[32m+[m[32m      "peerDependenciesMeta": {[m
[32m+[m[32m        "@firebase/app": {[m
[32m+[m[32m          "optional": true[m
[32m+[m[32m        },[m
[32m+[m[32m        "@firebase/app-compat": {[m
[32m+[m[32m          "optional": true[m
[32m+[m[32m        }[m
       }[m
     },[m
     "node_modules/@firebase/database-types": {[m
[31m-      "version": "0.10.4",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/database-types/-/database-types-0.10.4.tgz",[m
[31m-      "integrity": "sha512-dPySn0vJ/89ZeBac70T+2tWWPiJXWbmRygYv0smT5TfE3hDrQ09eKMF3Y+vMlTdrMWq7mUdYW5REWPSGH4kAZQ==",[m
[32m+[m[32m      "version": "1.0.21",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/database-types/-/database-types-1.0.21.tgz",[m
[32m+[m[32m      "integrity": "sha512-SX1jUqhttKgg/m9dYRTvqU9QvucBooziWfA986r4cpsbi4zlsvewe424j3Vpduwd6DG1MSAMfBVT2VqA61FnkA==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "@firebase/app-types": "0.9.0",[m
[31m-        "@firebase/util": "1.9.3"[m
[32m+[m[32m        "@firebase/app-types": "0.9.5",[m
[32m+[m[32m        "@firebase/util": "1.15.2"[m
       }[m
     },[m
     "node_modules/@firebase/logger": {[m
[31m-      "version": "0.4.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/logger/-/logger-0.4.0.tgz",[m
[31m-      "integrity": "sha512-eRKSeykumZ5+cJPdxxJRgAC3G5NknY2GwEbKfymdnXtnT0Ucm4pspfR6GT4MUQEDuJwRVbVcSx85kgJulMoFFA==",[m
[32m+[m[32m      "version": "0.5.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/logger/-/logger-0.5.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-vZKLsqE1ABOy8OjQiE7cUTFn4gvaqlk88yp8N94Pk/sDpq61YqZGqmVFZTvOyflTwuYFcWirBdYGoJgbDaXKYQ==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
         "tslib": "^2.1.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=20.0.0"[m
       }[m
     },[m
     "node_modules/@firebase/util": {[m
[31m-      "version": "1.9.3",[m
[31m-      "resolved": "https://registry.npmjs.org/@firebase/util/-/util-1.9.3.tgz",[m
[31m-      "integrity": "sha512-DY02CRhOZwpzO36fHpuVysz6JZrscPiBXD0fXp6qSrL9oNOx5KWICKdR95C0lSITzxp0TZosVyHqzatE8JbcjA==",[m
[32m+[m[32m      "version": "1.15.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@firebase/util/-/util-1.15.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-974pWIZVLDMc5GW5YAsj8y0XxULxIy/sPUy7tsxmWbF93KRIyh9xpuHlh0zDL+shUcf5nHDjFOg9YLiQ763eiA==",[m
[32m+[m[32m      "hasInstallScript": true,[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
         "tslib": "^2.1.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=20.0.0"[m
       }[m
     },[m
     "node_modules/@google-cloud/firestore": {[m
[31m-      "version": "6.8.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@google-cloud/firestore/-/firestore-6.8.0.tgz",[m
[31m-      "integrity": "sha512-JRpk06SmZXLGz0pNx1x7yU3YhkUXheKgH5hbDZ4kMsdhtfV5qPLJLRI4wv69K0cZorIk+zTMOwptue7hizo0eA==",[m
[32m+[m[32m      "version": "8.7.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@google-cloud/firestore/-/firestore-8.7.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-Hp/WI8sH569ANitsko6RNvCUkzTCYudHoINOkQjiJq2FBG6kKnofBAW7PtS823cu6RMxHqK2RxRcspdjrRpUFA==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "fast-deep-equal": "^3.1.1",[m
[32m+[m[32m        "@opentelemetry/api": "^1.9.0",[m
[32m+[m[32m        "fast-deep-equal": "^3.1.3",[m
         "functional-red-black-tree": "^1.0.1",[m
[31m-        "google-gax": "^3.5.7",[m
[31m-        "protobufjs": "^7.2.5"[m
[32m+[m[32m        "google-gax": "^5.0.1",[m
[32m+[m[32m        "protobufjs": "^7.5.3"[m
       },[m
       "engines": {[m
[31m-        "node": ">=12.0.0"[m
[32m+[m[32m        "node": ">=18"[m
       }[m
     },[m
     "node_modules/@google-cloud/paginator": {[m
[31m-      "version": "3.0.7",[m
[31m-      "resolved": "https://registry.npmjs.org/@google-cloud/paginator/-/paginator-3.0.7.tgz",[m
[31m-      "integrity": "sha512-jJNutk0arIQhmpUUQJPJErsojqo834KcyB6X7a1mxuic8i1tKXxde8E69IZxNZawRIlZdIK2QY4WALvlK5MzYQ==",[m
[32m+[m[32m      "version": "5.0.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@google-cloud/paginator/-/paginator-5.0.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-DJS3s0OVH4zFDB1PzjxAsHqJT6sKVbRwwML0ZBP9PbU7Yebtu/7SWMRzvO2J3nUi9pRNITCfu4LJeooM2w4pjg==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
[36m@@ -184,117 +167,122 @@[m
         "extend": "^3.0.2"[m
       },[m
       "engines": {[m
[31m-        "node": ">=10"[m
[32m+[m[32m        "node": ">=14.0.0"[m
       }[m
     },[m
     "node_modules/@google-cloud/projectify": {[m
[31m-      "version": "3.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@google-cloud/projectify/-/projectify-3.0.0.tgz",[m
[31m-      "integrity": "sha512-HRkZsNmjScY6Li8/kb70wjGlDDyLkVk3KvoEo9uIoxSjYLJasGiCch9+PqRVDOCGUFvEIqyogl+BeqILL4OJHA==",[m
[32m+[m[32m      "version": "4.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@google-cloud/projectify/-/projectify-4.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-MmaX6HeSvyPbWGwFq7mXdo0uQZLGBYCwziiLIGq5JVX+/bdI3SAq6bP98trV5eTWfLuvsMcIC1YJOF2vfteLFA==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "engines": {[m
[31m-        "node": ">=12.0.0"[m
[32m+[m[32m        "node": ">=14.0.0"[m
       }[m
     },[m
     "node_modules/@google-cloud/promisify": {[m
[31m-      "version": "3.0.1",[m
[31m-      "resolved": "https://registry.npmjs.org/@google-cloud/promisify/-/promisify-3.0.1.tgz",[m
[31m-      "integrity": "sha512-z1CjRjtQyBOYL+5Qr9DdYIfrdLBe746jRTYfaYU6MeXkqp7UfYs/jX16lFFVzZ7PGEJvqZNqYUEtb1mvDww4pA==",[m
[32m+[m[32m      "version": "4.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@google-cloud/promisify/-/promisify-4.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-Orxzlfb9c67A15cq2JQEyVc7wEsmFBmHjZWZYQMUyJ1qivXyMwdyNOs9odi79hze+2zqdTtu1E19IM/FtqZ10g==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "engines": {[m
[31m-        "node": ">=12"[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
     "node_modules/@google-cloud/storage": {[m
[31m-      "version": "6.12.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@google-cloud/storage/-/storage-6.12.0.tgz",[m
[31m-      "integrity": "sha512-78nNAY7iiZ4O/BouWMWTD/oSF2YtYgYB3GZirn0To6eBOugjXVoK+GXgUXOl+HlqbAOyHxAVXOlsj3snfbQ1dw==",[m
[32m+[m[32m      "version": "7.21.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@google-cloud/storage/-/storage-7.21.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-l+IFTkd+6Y5LoAuXyYCKNAKtw/Ci+rAMqgdTB1jv4iZiLhw0rtq+0qjIRbBizXkNzEFmXiXUW0H7sZQQvk1ffA==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "@google-cloud/paginator": "^3.0.7",[m
[31m-        "@google-cloud/projectify": "^3.0.0",[m
[31m-        "@google-cloud/promisify": "^3.0.0",[m
[32m+[m[32m        "@google-cloud/paginator": "^5.0.0",[m
[32m+[m[32m        "@google-cloud/projectify": "^4.0.0",[m
[32m+[m[32m        "@google-cloud/promisify": "<4.1.0",[m
         "abort-controller": "^3.0.0",[m
         "async-retry": "^1.3.3",[m
[31m-        "compressible": "^2.0.12",[m
[31m-        "duplexify": "^4.0.0",[m
[31m-        "ent": "^2.2.0",[m
[31m-        "extend": "^3.0.2",[m
[31m-        "fast-xml-parser": "^4.2.2",[m
[31m-        "gaxios": "^5.0.0",[m
[31m-        "google-auth-library": "^8.0.1",[m
[32m+[m[32m        "duplexify": "^4.1.3",[m
[32m+[m[32m        "fast-xml-parser": "^5.3.4",[m
[32m+[m[32m        "gaxios": "^6.0.2",[m
[32m+[m[32m        "google-auth-library": "^9.6.3",[m
[32m+[m[32m        "html-entities": "^2.5.2",[m
         "mime": "^3.0.0",[m
[31m-        "mime-types": "^2.0.8",[m
         "p-limit": "^3.0.1",[m
[31m-        "retry-request": "^5.0.0",[m
[31m-        "teeny-request": "^8.0.0",[m
[31m-        "uuid": "^8.0.0"[m
[32m+[m[32m        "retry-request": "^7.0.0",[m
[32m+[m[32m        "teeny-request": "^9.0.0"[m
       },[m
       "engines": {[m
[31m-        "node": ">=12"[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
[31m-    "node_modules/@google-cloud/storage/node_modules/mime-db": {[m
[31m-      "version": "1.52.0",[m
[31m-      "resolved": "https://registry.npmjs.org/mime-db/-/mime-db-1.52.0.tgz",[m
[31m-      "integrity": "sha512-sPU4uV7dYlvtWJxwwxHD0PuihVNiE7TyAbQ5SWxDCB9mUYvOgroQOwYQQOKPJ8CIbE+1ETVlOoK1UC2nU3gYvg==",[m
[31m-      "license": "MIT",[m
[32m+[m[32m    "node_modules/@google-cloud/storage/node_modules/gcp-metadata": {[m
[32m+[m[32m      "version": "6.1.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/gcp-metadata/-/gcp-metadata-6.1.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-a4tiq7E0/5fTjxPAaH4jpjkSv/uCaU2p5KC6HVGrvl0cDjA8iBZv4vv1gyzlmK0ZUKqwpOyQMKzZQe3lTit77A==",[m
[32m+[m[32m      "license": "Apache-2.0",[m
       "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "gaxios": "^6.1.1",[m
[32m+[m[32m        "google-logging-utils": "^0.0.2",[m
[32m+[m[32m        "json-bigint": "^1.0.0"[m
[32m+[m[32m      },[m
       "engines": {[m
[31m-        "node": ">= 0.6"[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
[31m-    "node_modules/@google-cloud/storage/node_modules/mime-types": {[m
[31m-      "version": "2.1.35",[m
[31m-      "resolved": "https://registry.npmjs.org/mime-types/-/mime-types-2.1.35.tgz",[m
[31m-      "integrity": "sha512-ZDY+bPm5zTTF+YpCrAU9nK0UgICYPT0QtT1NZWFv4s++TNkcgVaT0g6+4R2uI4MjQjzysHB1zxuWL50hzaeXiw==",[m
[31m-      "license": "MIT",[m
[32m+[m[32m    "node_modules/@google-cloud/storage/node_modules/google-auth-library": {[m
[32m+[m[32m      "version": "9.15.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/google-auth-library/-/google-auth-library-9.15.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-Jb6Z0+nvECVz+2lzSMt9u98UsoakXxA2HGHMCxh+so3n90XgYWkq5dur19JAJV7ONiJY22yBTyJB1TSkvPq9Ng==",[m
[32m+[m[32m      "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "mime-db": "1.52.0"[m
[32m+[m[32m        "base64-js": "^1.3.0",[m
[32m+[m[32m        "ecdsa-sig-formatter": "^1.0.11",[m
[32m+[m[32m        "gaxios": "^6.1.1",[m
[32m+[m[32m        "gcp-metadata": "^6.1.0",[m
[32m+[m[32m        "gtoken": "^7.0.0",[m
[32m+[m[32m        "jws": "^4.0.0"[m
       },[m
       "engines": {[m
[31m-        "node": ">= 0.6"[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
[31m-    "node_modules/@google-cloud/storage/node_modules/uuid": {[m
[31m-      "version": "8.3.2",[m
[31m-      "resolved": "https://registry.npmjs.org/uuid/-/uuid-8.3.2.tgz",[m
[31m-      "integrity": "sha512-+NYs2QeMWy+GWFOEm9xnn6HCDp0l7QBD7ml8zLUmJ+93Q5NF0NocErnwkTkXVFNiX3/fpC6afS8Dhb/gz7R7eg==",[m
[31m-      "deprecated": "uuid@10 and below is no longer supported.  For ESM codebases, update to uuid@latest.  For CommonJS codebases, use uuid@11 (but be aware this version will likely be deprecated in 2028).",[m
[31m-      "license": "MIT",[m
[32m+[m[32m    "node_modules/@google-cloud/storage/node_modules/google-logging-utils": {[m
[32m+[m[32m      "version": "0.0.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/google-logging-utils/-/google-logging-utils-0.0.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-NEgUnEcBiP5HrPzufUkBzJOD/Sxsco3rLNo1F1TNf7ieU8ryUzBhqba8r756CjLX7rn3fHl6iLEwPYuqpoKgQQ==",[m
[32m+[m[32m      "license": "Apache-2.0",[m
       "optional": true,[m
[31m-      "bin": {[m
[31m-        "uuid": "dist/bin/uuid"[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
     "node_modules/@grpc/grpc-js": {[m
[31m-      "version": "1.8.22",[m
[31m-      "resolved": "https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.8.22.tgz",[m
[31m-      "integrity": "sha512-oAjDdN7fzbUi+4hZjKG96MR6KTEubAeMpQEb+77qy+3r0Ua5xTFuie6JOLr4ZZgl5g+W5/uRTS2M1V8mVAFPuA==",[m
[32m+[m[32m      "version": "1.14.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@grpc/grpc-js/-/grpc-js-1.14.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-k9Dj3DV/itK9D06Y8f190Qgop7/Ui+D0njFV3LHMPwPT75DpXLQohE9Wmz0QElrJnzsjB7KPWiKJbOl7IPDArQ==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "@grpc/proto-loader": "^0.7.0",[m
[31m-        "@types/node": ">=12.12.47"[m
[32m+[m[32m        "@grpc/proto-loader": "^0.8.0",[m
[32m+[m[32m        "@js-sdsl/ordered-map": "^4.4.2"[m
       },[m
       "engines": {[m
[31m-        "node": "^8.13.0 || >=10.10.0"[m
[32m+[m[32m        "node": ">=12.10.0"[m
       }[m
     },[m
     "node_modules/@grpc/proto-loader": {[m
[31m-      "version": "0.7.15",[m
[31m-      "resolved": "https://registry.npmjs.org/@grpc/proto-loader/-/proto-loader-0.7.15.tgz",[m
[31m-      "integrity": "sha512-tMXdRCfYVixjuFK+Hk0Q1s38gV9zDiDJfWL3h1rv4Qc39oILCu1TRTDt7+fGUI8K4G1Fj125Hx/ru3azECWTyQ==",[m
[32m+[m[32m      "version": "0.8.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@grpc/proto-loader/-/proto-loader-0.8.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-wtF6h+DY6M3YaDBPAmvuuA6jV8Sif9MjtOI5euKFWRgCDl5PeDpPsHR9u2l6St5ceY8AZgoNDww5+HvEsXFsGg==",[m
       "license": "Apache-2.0",[m
       "optional": true,[m
       "dependencies": {[m
         "lodash.camelcase": "^4.3.0",[m
         "long": "^5.0.0",[m
[31m-        "protobufjs": "^7.2.5",[m
[32m+[m[32m        "protobufjs": "^7.5.5",[m
         "yargs": "^17.7.2"[m
       },[m
       "bin": {[m
[36m@@ -304,17 +292,66 @@[m
         "node": ">=6"[m
       }[m
     },[m
[31m-    "node_modules/@jsdoc/salty": {[m
[31m-      "version": "0.2.12",[m
[31m-      "resolved": "https://registry.npmjs.org/@jsdoc/salty/-/salty-0.2.12.tgz",[m
[31m-      "integrity": "sha512-TuB0x50EoAvEX/UEWITd8Mkn3WhiTjSvbTMCLj0BhsQEl5iUzjXdA0bETEVpTk+5TGTLR6QktI9H4hLviVeaAQ==",[m
[31m-      "license": "Apache-2.0",[m
[32m+[m[32m    "node_modules/@isaacs/cliui": {[m
[32m+[m[32m      "version": "8.0.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@isaacs/cliui/-/cliui-8.0.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-O8jcjabXaleOG9DQ0+ARXWZBTfnP4WNAqzuiJK7ll44AmxGKv/J2M4TPjxjY3znBCfvBXFzucm1twdyFybFqEA==",[m
[32m+[m[32m      "license": "ISC",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "lodash": "^4.18.1"[m
[32m+[m[32m        "string-width": "^5.1.2",[m
[32m+[m[32m        "string-width-cjs": "npm:string-width@^4.2.0",[m
[32m+[m[32m        "strip-ansi": "^7.0.1",[m
[32m+[m[32m        "strip-ansi-cjs": "npm:strip-ansi@^6.0.1",[m
[32m+[m[32m        "wrap-ansi": "^8.1.0",[m
[32m+[m[32m        "wrap-ansi-cjs": "npm:wrap-ansi@^7.0.0"[m
       },[m
       "engines": {[m
[31m-        "node": ">=v12.0.0"[m
[32m+[m[32m        "node": ">=12"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/@js-sdsl/ordered-map": {[m
[32m+[m[32m      "version": "4.4.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@js-sdsl/ordered-map/-/ordered-map-4.4.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-iUKgm52T8HOE/makSxjqoWhe95ZJA1/G1sYsGev2JDKUSS14KAgg1LHb+Ba+IPow0xflbnSkOsZcO08C7w1gYw==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "funding": {[m
[32m+[m[32m        "type": "opencollective",[m
[32m+[m[32m        "url": "https://opencollective.com/js-sdsl"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/@nodable/entities": {[m
[32m+[m[32m      "version": "3.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@nodable/entities/-/entities-3.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-8L9xFeTYKhm49xfIypoe2W5wV1m/3Z58kT+7kR9A8OyFxcPduI4VmxaUMQyKYrRjUoLLSXv6EKKID5Tvj9cUVw==",[m
[32m+[m[32m      "funding": [[m
[32m+[m[32m        {[m
[32m+[m[32m          "type": "github",[m
[32m+[m[32m          "url": "https://github.com/sponsors/nodable"[m
[32m+[m[32m        }[m
[32m+[m[32m      ],[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/@opentelemetry/api": {[m
[32m+[m[32m      "version": "1.9.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@opentelemetry/api/-/api-1.9.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-gLyJlPHPZYdAk1JENA9LeHejZe1Ti77/pTeFm/nMXmQH/HFZlcS/O2XJB+L8fkbrNSqhdtlvjBVjxwUYanNH5Q==",[m
[32m+[m[32m      "license": "Apache-2.0",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=8.0.0"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/@pkgjs/parseargs": {[m
[32m+[m[32m      "version": "0.11.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@pkgjs/parseargs/-/parseargs-0.11.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-+1VkjdD0QBLPodGrJUeqarH8VAIvQODIbwh9XpP5Syisf7YoQgsJKPNFoqqLQlu+VQ/tVSshMR6loPMn8U+dPg==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=14"[m
       }[m
     },[m
     "node_modules/@protobufjs/aspromise": {[m
[36m@@ -362,13 +399,6 @@[m
       "license": "BSD-3-Clause",[m
       "optional": true[m
     },[m
[31m-    "node_modules/@protobufjs/inquire": {[m
[31m-      "version": "1.1.2",[m
[31m-      "resolved": "https://registry.npmjs.org/@protobufjs/inquire/-/inquire-1.1.2.tgz",[m
[31m-      "integrity": "sha512-pa0vFRuws4wkvaXKK1uXZMAwAX4/t8ANaJo45iw/oQHNQ9q5xUzwgFmVJGXiga2BeN+zpX7Vf9vmsiIa2J+MUw==",[m
[31m-      "license": "BSD-3-Clause",[m
[31m-      "optional": true[m
[31m-    },[m
     "node_modules/@protobufjs/path": {[m
       "version": "1.1.2",[m
       "resolved": "https://registry.npmjs.org/@protobufjs/path/-/path-1.1.2.tgz",[m
[36m@@ -400,16 +430,12 @@[m
         "node": ">= 10"[m
       }[m
     },[m
[31m-    "node_modules/@types/glob": {[m
[31m-      "version": "8.1.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/glob/-/glob-8.1.0.tgz",[m
[31m-      "integrity": "sha512-IO+MJPVhoqz+28h1qLAcBEH2+xHMK6MTyHJc7MTnnYb6wsoLR29POVGJ7LycmVXIqyy/4/2ShP5sUwTXuOwb/w==",[m
[32m+[m[32m    "node_modules/@types/caseless": {[m
[32m+[m[32m      "version": "0.12.5",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@types/caseless/-/caseless-0.12.5.tgz",[m
[32m+[m[32m      "integrity": "sha512-hWtVTC2q7hc7xZ/RLbxapMvDMgUnDvKvMOpKal4DrMyfGBUfB1oKaZlIRr6mJL+If3bAP6sV/QneGzF6tJjZDg==",[m
       "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "@types/minimatch": "^5.1.2",[m
[31m-        "@types/node": "*"[m
[31m-      }[m
[32m+[m[32m      "optional": true[m
     },[m
     "node_modules/@types/jsonwebtoken": {[m
       "version": "9.0.10",[m
[36m@@ -421,45 +447,6 @@[m
         "@types/node": "*"[m
       }[m
     },[m
[31m-    "node_modules/@types/linkify-it": {[m
[31m-      "version": "5.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/linkify-it/-/linkify-it-5.0.0.tgz",[m
[31m-      "integrity": "sha512-sVDA58zAw4eWAffKOaQH5/5j3XeayukzDk+ewSsnv3p4yJEZHCCzMDiZM8e0OUrRvmpGZ85jf4yDHkHsgBNr9Q==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
[31m-    "node_modules/@types/long": {[m
[31m-      "version": "4.0.2",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/long/-/long-4.0.2.tgz",[m
[31m-      "integrity": "sha512-MqTGEo5bj5t157U6fA/BiDynNkn0YknVdh48CMPkTSpFTVmvao5UQmm7uEF6xBEo7qIMAlY/JSleYaE6VOdpaA==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
[31m-    "node_modules/@types/markdown-it": {[m
[31m-      "version": "14.1.2",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/markdown-it/-/markdown-it-14.1.2.tgz",[m
[31m-      "integrity": "sha512-promo4eFwuiW+TfGxhi+0x3czqTYJkG8qB17ZUJiVF10Xm7NLVRSLUsfRTU/6h1e24VvRnXCx+hG7li58lkzog==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "@types/linkify-it": "^5",[m
[31m-        "@types/mdurl": "^2"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/@types/mdurl": {[m
[31m-      "version": "2.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/mdurl/-/mdurl-2.0.0.tgz",[m
[31m-      "integrity": "sha512-RGdgjQUZba5p6QEFAVx2OGb8rQDL/cPRG7GiedRzMcJ1tYnUANBncjbSB1NRGwbvjcPeikRABz2nshyPk1bhWg==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
[31m-    "node_modules/@types/minimatch": {[m
[31m-      "version": "5.1.2",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/minimatch/-/minimatch-5.1.2.tgz",[m
[31m-      "integrity": "sha512-K0VQKziLUWkVKiRVrx4a40iPaxTUefQmjtkQofBkYRcoaaL/8rhwDWww9qWbrgicNOgnpIsMxyNIUM4+n6dUIA==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
     "node_modules/@types/ms": {[m
       "version": "2.1.0",[m
       "resolved": "https://registry.npmjs.org/@types/ms/-/ms-2.1.0.tgz",[m
[36m@@ -467,25 +454,34 @@[m
       "license": "MIT"[m
     },[m
     "node_modules/@types/node": {[m
[31m-      "version": "26.1.1",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/node/-/node-26.1.1.tgz",[m
[31m-      "integrity": "sha512-nxAkRSVkN1Y0JC1W8ky/fTfkGsMmcrRsbx+3XoZE+rMOX71kLYTV7fLXpqud1GpbpP5TuffXFqfX7fH2GgZREw==",[m
[32m+[m[32m      "version": "26.2.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@types/node/-/node-26.2.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-5IviulTZeRNp2vAJ514cc/HUlY5nZ9fCbq9DMyC52BrhFZACo3nI0R7qBxhQmo/d27NFe96ur/b7Wwxklda+kg==",[m
       "license": "MIT",[m
       "dependencies": {[m
         "undici-types": "~8.3.0"[m
       }[m
     },[m
[31m-    "node_modules/@types/rimraf": {[m
[31m-      "version": "3.0.2",[m
[31m-      "resolved": "https://registry.npmjs.org/@types/rimraf/-/rimraf-3.0.2.tgz",[m
[31m-      "integrity": "sha512-F3OznnSLAUxFrCEu/L5PY8+ny8DtcFRjx7fZZ9bycvXRi3KPTRS9HOitGZwvPg0juRhXFWIeKX58cnX5YqLohQ==",[m
[32m+[m[32m    "node_modules/@types/request": {[m
[32m+[m[32m      "version": "2.48.13",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@types/request/-/request-2.48.13.tgz",[m
[32m+[m[32m      "integrity": "sha512-FGJ6udDNUCjd19pp0Q3iTiDkwhYup7J8hpMW9c4k53NrccQFFWKRho6hvtPPEhnXWKvukfwAlB6DbDz4yhH5Gg==",[m
       "license": "MIT",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "@types/glob": "*",[m
[31m-        "@types/node": "*"[m
[32m+[m[32m        "@types/caseless": "*",[m
[32m+[m[32m        "@types/node": "*",[m
[32m+[m[32m        "@types/tough-cookie": "*",[m
[32m+[m[32m        "form-data": "^2.5.5"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/@types/tough-cookie": {[m
[32m+[m[32m      "version": "4.0.5",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/@types/tough-cookie/-/tough-cookie-4.0.5.tgz",[m
[32m+[m[32m      "integrity": "sha512-/Ad8+nIOV7Rl++6f1BdKxFSMgmoqEoYbHRpPcx3JEfv8VRsQe9Z4mCXeJBzxs7mbHY/XOZZuXlRNfhpVPbs6ZA==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true[m
[32m+[m[32m    },[m
     "node_modules/abort-controller": {[m
       "version": "3.0.0",[m
       "resolved": "https://registry.npmjs.org/abort-controller/-/abort-controller-3.0.0.tgz",[m
[36m@@ -512,73 +508,52 @@[m
         "node": ">= 0.6"[m
       }[m
     },[m
[31m-    "node_modules/acorn": {[m
[31m-      "version": "8.17.0",[m
[31m-      "resolved": "https://registry.npmjs.org/acorn/-/acorn-8.17.0.tgz",[m
[31m-      "integrity": "sha512-xRQbDb9BnwDafYNn6Vwl839DYVjqXYb1XVGtWAZ1kcDc6iwAL4hg3B1dZlRiuENFeO2H53gFG3in621AdERVAg==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "bin": {[m
[31m-        "acorn": "bin/acorn"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=0.4.0"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/acorn-jsx": {[m
[31m-      "version": "5.3.2",[m
[31m-      "resolved": "https://registry.npmjs.org/acorn-jsx/-/acorn-jsx-5.3.2.tgz",[m
[31m-      "integrity": "sha512-rq9s+JNhf0IChjtDXxllJ7g41oZk5SlXtp0LHwyA5cejwn7vKmKp4pPri6YEePv2PU65sAsegbXtIinmDFDXgQ==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "peerDependencies": {[m
[31m-        "acorn": "^6.0.0 || ^7.0.0 || ^8.0.0"[m
[31m-      }[m
[31m-    },[m
     "node_modules/agent-base": {[m
[31m-      "version": "6.0.2",[m
[31m-      "resolved": "https://registry.npmjs.org/agent-base/-/agent-base-6.0.2.tgz",[m
[31m-      "integrity": "sha512-RZNwNclF7+MS/8bDg70amg32dyeZGZxiDuQmZxKLAlQjr3jGyLx+4Kkk58UO7D2QdgFIQCovuSuZESne6RG6XQ==",[m
[32m+[m[32m      "version": "7.1.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/agent-base/-/agent-base-7.1.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-MnA+YT8fwfJPgBx3m60MNqakm30XOkyIoH1y6huTQvC0PwZG7ki8NacLBcrPbNoo8vEZy7Jpuk7+jMO+CUovTQ==",[m
       "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "debug": "4"[m
[31m-      },[m
       "engines": {[m
[31m-        "node": ">= 6.0.0"[m
[32m+[m[32m        "node": ">= 14"[m
       }[m
     },[m
     "node_modules/ansi-regex": {[m
[31m-      "version": "5.0.1",[m
[31m-      "resolved": "https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz",[m
[31m-      "integrity": "sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==",[m
[32m+[m[32m      "version": "6.2.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/ansi-regex/-/ansi-regex-6.2.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-Bq3SmSpyFHaWjPk8If9yc6svM8c56dB5BAtW4Qbw5jHTwwXXcTLoRMkpDJp6VL0XzlWaCHTXrkFURMYmD0sLqg==",[m
       "license": "MIT",[m
       "optional": true,[m
       "engines": {[m
[31m-        "node": ">=8"[m
[32m+[m[32m        "node": ">=12"[m
[32m+[m[32m      },[m
[32m+[m[32m      "funding": {[m
[32m+[m[32m        "url": "https://github.com/chalk/ansi-regex?sponsor=1"[m
       }[m
     },[m
     "node_modules/ansi-styles": {[m
[31m-      "version": "4.3.0",[m
[31m-      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",[m
[31m-      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",[m
[32m+[m[32m      "version": "6.2.3",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-6.2.3.tgz",[m
[32m+[m[32m      "integrity": "sha512-4Dj6M28JB+oAH8kFkTLUo+a2jwOFkuqb3yucU0CANcRRUbxS0cP0nZYCGjcc3BNXwRIsUVmDGgzawme7zvJHvg==",[m
       "license": "MIT",[m
       "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "color-convert": "^2.0.1"[m
[31m-      },[m
       "engines": {[m
[31m-        "node": ">=8"[m
[32m+[m[32m        "node": ">=12"[m
       },[m
       "funding": {[m
         "url": "https://github.com/chalk/ansi-styles?sponsor=1"[m
       }[m
     },[m
[31m-    "node_modules/argparse": {[m
[31m-      "version": "2.0.1",[m
[31m-      "resolved": "https://registry.npmjs.org/argparse/-/argparse-2.0.1.tgz",[m
[31m-      "integrity": "sha512-8+9WqebbFzpX9OR+Wa6O29asIogeRMzcGtAINdpMHHyAg10f05aSFVBbcEqGf/PXw1EjAZ+q2/bEBg3DvurK3Q==",[m
[31m-      "license": "Python-2.0",[m
[32m+[m[32m    "node_modules/anynum": {[m
[32m+[m[32m      "version": "1.0.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/anynum/-/anynum-1.0.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-N6//FLET/tXYNM/F6ABca1oH6fWB+KlTt909Le28WMDBk8oaT4vY17DCrwg2MvmuqUKt3Ni4N5dGJ/EoBgcO6A==",[m
[32m+[m[32m      "funding": [[m
[32m+[m[32m        {[m
[32m+[m[32m          "type": "github",[m
[32m+[m[32m          "url": "https://github.com/sponsors/NaturalIntelligence"[m
[32m+[m[32m        }[m
[32m+[m[32m      ],[m
[32m+[m[32m      "license": "MIT",[m
       "optional": true[m
     },[m
     "node_modules/arrify": {[m
[36m@@ -601,6 +576,13 @@[m
         "retry": "0.13.1"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/asynckit": {[m
[32m+[m[32m      "version": "0.4.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/asynckit/-/asynckit-0.4.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-Oei9OH4tRh0YqU3GxhX79dM/mwVgvbZJaSNaRk+bshkj0S5cfHcgYakreBjrHwatXKbz+IoIdYLxrKim2MjW0Q==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true[m
[32m+[m[32m    },[m
     "node_modules/balanced-match": {[m
       "version": "1.0.2",[m
       "resolved": "https://registry.npmjs.org/balanced-match/-/balanced-match-1.0.2.tgz",[m
[36m@@ -626,26 +608,17 @@[m
           "url": "https://feross.org/support"[m
         }[m
       ],[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[32m+[m[32m      "license": "MIT"[m
     },[m
     "node_modules/bignumber.js": {[m
       "version": "9.3.1",[m
       "resolved": "https://registry.npmjs.org/bignumber.js/-/bignumber.js-9.3.1.tgz",[m
       "integrity": "sha512-Ko0uX15oIUS7wJ3Rb30Fs6SkVbLmPBAKdlm7q9+ak9bbIeFf0MwuBsQV6z7+X768/cHsfg+WlysDWJcmthjsjQ==",[m
       "license": "MIT",[m
[31m-      "optional": true,[m
       "engines": {[m
         "node": "*"[m
       }[m
     },[m
[31m-    "node_modules/bluebird": {[m
[31m-      "version": "3.7.2",[m
[31m-      "resolved": "https://registry.npmjs.org/bluebird/-/bluebird-3.7.2.tgz",[m
[31m-      "integrity": "sha512-XpNj6GDQzdfW+r2Wnn7xiSAd7TM3jzkxGXBGTtWKuSXv1xUV+azxAm8jdWZN06QTQk+2N2XB9jRDkvbmQmcRtg==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
     "node_modules/body-parser": {[m
       "version": "2.3.0",[m
       "resolved": "https://registry.npmjs.org/body-parser/-/body-parser-2.3.0.tgz",[m
[36m@@ -684,9 +657,9 @@[m
       }[m
     },[m
     "node_modules/brace-expansion": {[m
[31m-      "version": "2.1.2",[m
[31m-      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-2.1.2.tgz",[m
[31m-      "integrity": "sha512-w5JZcKgdhDOgOwm8H+KgbosopHMuGcl6qbulwjtz3SM7I7P3yW1eAjzMPLrIE+NQ9vjgANKHWeMHnrT0OXW1oA==",[m
[32m+[m[32m      "version": "2.1.4",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/brace-expansion/-/brace-expansion-2.1.4.tgz",[m
[32m+[m[32m      "integrity": "sha512-hGfVzPxthbf3+2yjg/RBs60cB0FhqBS/zvdV/4wn4/BmN0bNMMHPc4V/BbFieqf1TKAGGAHnY4eSjajCl0f2Xg==",[m
       "license": "MIT",[m
       "optional": true,[m
       "dependencies": {[m
[36m@@ -737,36 +710,6 @@[m
         "url": "https://github.com/sponsors/ljharb"[m
       }[m
     },[m
[31m-    "node_modules/catharsis": {[m
[31m-      "version": "0.9.0",[m
[31m-      "resolved": "https://registry.npmjs.org/catharsis/-/catharsis-0.9.0.tgz",[m
[31m-      "integrity": "sha512-prMTQVpcns/tzFgFVkVp6ak6RykZyWb3gu8ckUpd6YkTlacOd3DXGJjIpD4Q6zJirizvaiAjSSHlOsA+6sNh2A==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "lodash": "^4.17.15"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">= 10"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/chalk": {[m
[31m-      "version": "4.1.2",[m
[31m-      "resolved": "https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz",[m
[31m-      "integrity": "sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "ansi-styles": "^4.1.0",[m
[31m-        "supports-color": "^7.1.0"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=10"[m
[31m-      },[m
[31m-      "funding": {[m
[31m-        "url": "https://github.com/chalk/chalk?sponsor=1"[m
[31m-      }[m
[31m-    },[m
     "node_modules/cliui": {[m
       "version": "8.0.1",[m
       "resolved": "https://registry.npmjs.org/cliui/-/cliui-8.0.1.tgz",[m
[36m@@ -782,14 +725,93 @@[m
         "node": ">=12"[m
       }[m
     },[m
[31m-    "node_modules/color-convert": {[m
[31m-      "version": "2.0.1",[m
[31m-      "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",[m
[31m-      "integrity": "sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==",[m
[32m+[m[32m    "node_modules/cliui/node_modules/ansi-regex": {[m
[32m+[m[32m      "version": "5.0.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/ansi-regex/-/ansi-regex-5.0.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-quJQXlTSUGL2LH9SUXo8VwsY4soanhgo6LNSm84E1LBcE8s3O0wpdiRzyR9z/ZZJMlMWv37qOOb9pdJlMUEKFQ==",[m
       "license": "MIT",[m
       "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "color-name": "~1.1.4"[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=8"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/cliui/node_modules/ansi-styles": {[m
[32m+[m[32m      "version": "4.3.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "color-convert": "^2.0.1"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=8"[m
[32m+[m[32m      },[m
[32m+[m[32m      "funding": {[m
[32m+[m[32m        "url": "https://github.com/chalk/ansi-styles?sponsor=1"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/cliui/node_modules/emoji-regex": {[m
[32m+[m[32m      "version": "8.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/emoji-regex/-/emoji-regex-8.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-MSjYzcWNOA0ewAHpz0MxpYFvwg6yjy1NG3xteoqz644VCo/RPgnr1/GGt+ic3iJTzQ8Eu3TdM14SawnVUmGE6A==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/cliui/node_modules/string-width": {[m
[32m+[m[32m      "version": "4.2.3",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/string-width/-/string-width-4.2.3.tgz",[m
[32m+[m[32m      "integrity": "sha512-wKyQRQpjJ0sIp62ErSZdGsjMJWsap5oRNihHhu6G7JVO/9jIB6UyevL+tXuOqrng8j/cxKTWyWUwvSTriiZz/g==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "emoji-regex": "^8.0.0",[m
[32m+[m[32m        "is-fullwidth-code-point": "^3.0.0",[m
[32m+[m[32m        "strip-ansi": "^6.0.1"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=8"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/cliui/node_modules/strip-ansi": {[m
[32m+[m[32m      "version": "6.0.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/strip-ansi/-/strip-ansi-6.0.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-Y38VPSHcqkFrCpFnQ9vuSXmquuv5oXOKpGeT6aGrr3o3Gc9AlVa6JBfUSOCnbxGGZF+/0ooI7KrPuUSztUdU5A==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "ansi-regex": "^5.0.1"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=8"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/cliui/node_modules/wrap-ansi": {[m
[32m+[m[32m      "version": "7.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/wrap-ansi/-/wrap-ansi-7.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-YVGIj2kamLSTxw6NsZjoBxfSwsn0ycdesmc4p+Q21c5zPuZ1pl+NfxVdxPtdHvmNVOQ6XSYG4AUtyt/Fi7D16Q==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "ansi-styles": "^4.0.0",[m
[32m+[m[32m        "string-width": "^4.1.0",[m
[32m+[m[32m        "strip-ansi": "^6.0.0"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=10"[m
[32m+[m[32m      },[m
[32m+[m[32m      "funding": {[m
[32m+[m[32m        "url": "https://github.com/chalk/wrap-ansi?sponsor=1"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/color-convert": {[m
[32m+[m[32m      "version": "2.0.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/color-convert/-/color-convert-2.0.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-RRECPsj7iu/xb5oKYcsFHSppFNnsj/52OVTRKb4zP5onXwVF3zVmmToNcOfGC+CRDpfK/U584fMg38ZHCaElKQ==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "color-name": "~1.1.4"[m
       },[m
       "engines": {[m
         "node": ">=7.0.0"[m
[36m@@ -802,17 +824,17 @@[m
       "license": "MIT",[m
       "optional": true[m
     },[m
[31m-    "node_modules/compressible": {[m
[31m-      "version": "2.0.18",[m
[31m-      "resolved": "https://registry.npmjs.org/compressible/-/compressible-2.0.18.tgz",[m
[31m-      "integrity": "sha512-AF3r7P5dWxL8MxyITRMlORQNaOA2IkAFaTr4k7BUumjPtRpGDTZpl0Pb1XCO6JeDCBdp126Cgs9sMxqSjgYyRg==",[m
[32m+[m[32m    "node_modules/combined-stream": {[m
[32m+[m[32m      "version": "1.0.8",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/combined-stream/-/combined-stream-1.0.8.tgz",[m
[32m+[m[32m      "integrity": "sha512-FQN4MRfuJeHf7cBbBMJFXhKSDq+2kAArBlmRBvcvFE5BB1HZKXtSFASDhdlz9zOYwxh8lDdnvmMOe/+5cdoEdg==",[m
       "license": "MIT",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "mime-db": ">= 1.43.0 < 2"[m
[32m+[m[32m        "delayed-stream": "~1.0.0"[m
       },[m
       "engines": {[m
[31m-        "node": ">= 0.6"[m
[32m+[m[32m        "node": ">= 0.8"[m
       }[m
     },[m
     "node_modules/content-disposition": {[m
[36m@@ -872,6 +894,30 @@[m
         "url": "https://opencollective.com/express"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/cross-spawn": {[m
[32m+[m[32m      "version": "7.0.6",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/cross-spawn/-/cross-spawn-7.0.6.tgz",[m
[32m+[m[32m      "integrity": "sha512-uV2QOWP2nWzsy2aMp8aRibhi9dlzF5Hgh5SHaB9OiTGEyDTiJJyx0uy51QXdyWbtAHNua4XJzUKca3OzKUd3vA==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "path-key": "^3.1.0",[m
[32m+[m[32m        "shebang-command": "^2.0.0",[m
[32m+[m[32m        "which": "^2.0.1"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">= 8"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
[32m+[m[32m    "node_modules/data-uri-to-buffer": {[m
[32m+[m[32m      "version": "4.0.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/data-uri-to-buffer/-/data-uri-to-buffer-4.0.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-0R9ikRb668HB7QDxT1vkpuUBtqc53YyAwMwGeUFKRojY/NWKvdZ+9UYtRfGmhqNbRkTSVpMbmyhXipFFv2cb/A==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">= 12"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
     "node_modules/debug": {[m
       "version": "4.4.3",[m
       "resolved": "https://registry.npmjs.org/debug/-/debug-4.4.3.tgz",[m
[36m@@ -889,12 +935,15 @@[m
         }[m
       }[m
     },[m
[31m-    "node_modules/deep-is": {[m
[31m-      "version": "0.1.4",[m
[31m-      "resolved": "https://registry.npmjs.org/deep-is/-/deep-is-0.1.4.tgz",[m
[31m-      "integrity": "sha512-oIPzksmTg4/MriiaYGO+okXDT7ztn/w3Eptv/+gSIdMdKsJo0u4CfYNFJPy+4SKMuCqGw2wxnA+URMg3t8a/bQ==",[m
[32m+[m[32m    "node_modules/delayed-stream": {[m
[32m+[m[32m      "version": "1.0.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/delayed-stream/-/delayed-stream-1.0.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-ZySD7Nf91aLB0RxL4KGrKHBXl7Eds1DAmEdcoVawXnLD7SDhpNgtuII2aAkg7a7QS41jxPSZ17p4VdGnMHk3MQ==",[m
       "license": "MIT",[m
[31m-      "optional": true[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">=0.4.0"[m
[32m+[m[32m      }[m
     },[m
     "node_modules/depd": {[m
       "version": "2.0.0",[m
[36m@@ -932,6 +981,13 @@[m
         "stream-shift": "^1.0.2"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/eastasianwidth": {[m
[32m+[m[32m      "version": "0.2.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/eastasianwidth/-/eastasianwidth-0.2.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-I88TYZWc9XiYHRQ4/3c5rjjfgkjhLyW2luGIheGERbNQ6OY7yTybanSpDXZa8y7VUP9YmDcYa+eyq4ca7iLqWA==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true[m
[32m+[m[32m    },[m
     "node_modules/ecdsa-sig-formatter": {[m
       "version": "1.0.11",[m
       "resolved": "https://registry.npmjs.org/ecdsa-sig-formatter/-/ecdsa-sig-formatter-1.0.11.tgz",[m
[36m@@ -948,9 +1004,9 @@[m
       "license": "MIT"[m
     },[m
     "node_modules/emoji-regex": {[m
[31m-      "version": "8.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/emoji-regex/-/emoji-regex-8.0.0.tgz",[m
[31m-      "integrity": "sha512-MSjYzcWNOA0ewAHpz0MxpYFvwg6yjy1NG3xteoqz644VCo/RPgnr1/GGt+ic3iJTzQ8Eu3TdM14SawnVUmGE6A==",[m
[32m+[m[32m      "version": "9.2.2",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/emoji-regex/-/emoji-regex-9.2.2.tgz",[m
[32m+[m[32m      "integrity": "sha512-L18DaJsXSUk2+42pv8mLs5jJT2hqFkFE4j21wOmgbUqsZ2hL72NsUU785g9RXgo3s0ZNgVl42TiHp3ZtOv/Vyg==",[m
       "license": "MIT",[m
       "optional": true[m
     },[m
[36m@@ -973,35 +1029,6 @@[m
         "once": "^1.4.0"[m
       }[m
     },[m
[31m-    "node_modules/ent": {[m
[31m-      "version": "2.2.2",[m
[31m-      "resolved": "https://registry.npmjs.org/ent/-/ent-2.2.2.tgz",[m
[31m-      "integrity": "sha512-kKvD1tO6BM+oK9HzCPpUdRb4vKFQY/FPTFmurMvh6LlN68VMrdj77w8yp51/kDbpkFOS9J8w5W6zIzgM2H8/hw==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "call-bound": "^1.0.3",[m
[31m-        "es-errors": "^1.3.0",[m
[31m-        "punycode": "^1.4.1",[m
[31m-        "safe-regex-test": "^1.1.0"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">= 0.4"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/entities": {[m
[31m-      "version": "4.5.0",[m
[31m-      "resolved": "https://registry.npmjs.org/entities/-/entities-4.5.0.tgz",[m
[31m-      "integrity": "sha512-V0hjH4dGPh9Ao5p0MoRY6BVqtwCjhz6vI5LT8AJ55H+4g9/4vbHx1I54fS0XuclLhDHArPQCiMjDxjaL8fPxhw==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=0.12"[m
[31m-      },[m
[31m-      "funding": {[m
[31m-        "url": "https://github.com/fb55/entities?sponsor=1"[m
[31m-      }[m
[31m-    },[m
     "node_modules/es-define-property": {[m
       "version": "1.0.1",[m
       "resolved": "https://registry.npmjs.org/es-define-property/-/es-define-property-1.0.1.tgz",[m
[36m@@ -1032,6 +1059,22 @@[m
         "node": ">= 0.4"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/es-set-tostringtag": {[m
[32m+[m[32m      "version": "2.1.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/es-set-tostringtag/-/es-set-tostringtag-2.1.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-j6vWzfrGVfyXxge+O0x5sh6cvxAog0a/4Rdd2K36zCMV5eJ+/+tOAngRO8cODMNWbVRdVlmGZQL2YS3yR8bIUA==",[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "es-errors": "^1.3.0",[m
[32m+[m[32m        "get-intrinsic": "^1.2.6",[m
[32m+[m[32m        "has-tostringtag": "^1.0.2",[m
[32m+[m[32m        "hasown": "^2.0.2"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": ">= 0.4"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
     "node_modules/escalade": {[m
       "version": "3.2.0",[m
       "resolved": "https://registry.npmjs.org/escalade/-/escalade-3.2.0.tgz",[m
[36m@@ -1048,114 +1091,6 @@[m
       "integrity": "sha512-NiSupZ4OeuGwr68lGIeym/ksIZMJodUGOSCZ/FSnTxcrekbvqrgdUxlJOMpijaKZVjAJrWrGs/6Jy8OMuyj9ow==",[m
       "license": "MIT"[m
     },[m
[31m-    "node_modules/escape-string-regexp": {[m
[31m-      "version": "2.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/escape-string-regexp/-/escape-string-regexp-2.0.0.tgz",[m
[31m-      "integrity": "sha512-UpzcLCXolUWcNu5HtVMHYdXJjArjsF9C0aNnquZYY4uW/Vu0miy5YoWvbV345HauVvcAUnpRuhMMcqTcGOY2+w==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=8"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/escodegen": {[m
[31m-      "version": "1.14.3",[m
[31m-      "resolved": "https://registry.npmjs.org/escodegen/-/escodegen-1.14.3.tgz",[m
[31m-      "integrity": "sha512-qFcX0XJkdg+PB3xjZZG/wKSuT1PnQWx57+TVSjIMmILd2yC/6ByYElPwJnslDsuWuSAp4AwJGumarAAmJch5Kw==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "esprima": "^4.0.1",[m
[31m-        "estraverse": "^4.2.0",[m
[31m-        "esutils": "^2.0.2",[m
[31m-        "optionator": "^0.8.1"[m
[31m-      },[m
[31m-      "bin": {[m
[31m-        "escodegen": "bin/escodegen.js",[m
[31m-        "esgenerate": "bin/esgenerate.js"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=4.0"[m
[31m-      },[m
[31m-      "optionalDependencies": {[m
[31m-        "source-map": "~0.6.1"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/escodegen/node_modules/estraverse": {[m
[31m-      "version": "4.3.0",[m
[31m-      "resolved": "https://registry.npmjs.org/estraverse/-/estraverse-4.3.0.tgz",[m
[31m-      "integrity": "sha512-39nnKffWz8xN1BU/2c79n9nB9HDzo0niYUqx6xyqUnyoAnQyyWpOTdZEeiCch8BBu515t4wp9ZmgVfVhn9EBpw==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=4.0"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/eslint-visitor-keys": {[m
[31m-      "version": "3.4.3",[m
[31m-      "resolved": "https://registry.npmjs.org/eslint-visitor-keys/-/eslint-visitor-keys-3.4.3.tgz",[m
[31m-      "integrity": "sha512-wpc+LXeiyiisxPlEkUzU6svyS1frIO3Mgxj1fdy7Pm8Ygzguax2N3Fa/D/ag1WqbOprdI+uY6wMUl8/a2G+iag==",[m
[31m-      "license": "Apache-2.0",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"[m
[31m-      },[m
[31m-      "funding": {[m
[31m-        "url": "https://opencollective.com/eslint"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/espree": {[m
[31m-      "version": "9.6.1",[m
[31m-      "resolved": "https://registry.npmjs.org/espree/-/espree-9.6.1.tgz",[m
[31m-      "integrity": "sha512-oruZaFkjorTpF32kDSI5/75ViwGeZginGGy2NoOSg3Q9bnwlnmDm4HLnkl0RE3n+njDXR037aY1+x58Z/zFdwQ==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "dependencies": {[m
[31m-        "acorn": "^8.9.0",[m
[31m-        "acorn-jsx": "^5.3.2",[m
[31m-        "eslint-visitor-keys": "^3.4.1"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": "^12.22.0 || ^14.17.0 || >=16.0.0"[m
[31m-      },[m
[31m-      "funding": {[m
[31m-        "url": "https://opencollective.com/eslint"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/esprima": {[m
[31m-      "version": "4.0.1",[m
[31m-      "resolved": "https://registry.npmjs.org/esprima/-/esprima-4.0.1.tgz",[m
[31m-      "integrity": "sha512-eGuFFw7Upda+g4p+QHvnW0RyTX/SVeJBDM/gCtMARO0cLuT2HcEKnTPvhjV6aGeqrCB/sbNop0Kszm0jsaWU4A==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "bin": {[m
[31m-        "esparse": "bin/esparse.js",[m
[31m-        "esvalidate": "bin/esvalidate.js"[m
[31m-      },[m
[31m-      "engines": {[m
[31m-        "node": ">=4"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/estraverse": {[m
[31m-      "version": "5.3.0",[m
[31m-      "resolved": "https://registry.npmjs.org/estraverse/-/estraverse-5.3.0.tgz",[m
[31m-      "integrity": "sha512-MMdARuVEQziNTeJD8DgMqmhwR11BRQ/cBP+pLtYdSTnf3MIO8fFeiINEbX36ZdNlfU/7A9f3gUw49B3oQsvwBA==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=4.0"[m
[31m-      }[m
[31m-    },[m
[31m-    "node_modules/esutils": {[m
[31m-      "version": "2.0.3",[m
[31m-      "resolved": "https://registry.npmjs.org/esutils/-/esutils-2.0.3.tgz",[m
[31m-      "integrity": "sha512-kVscqXk4OCp68SZ0dkgEKVi6/8ij300KBWTJq32P/dYeWTSwK41WyTxalN1eRmA5Z9UU/LX9D7FWSmV9SAYx6g==",[m
[31m-      "license": "BSD-2-Clause",[m
[31m-      "optional": true,[m
[31m-      "engines": {[m
[31m-        "node": ">=0.10.0"[m
[31m-      }[m
[31m-    },[m
     "node_modules/etag": {[m
       "version": "1.8.1",[m
       "resolved": "https://registry.npmjs.org/etag/-/etag-1.8.1.tgz",[m
[36m@@ -1222,34 +1157,35 @@[m
       "version": "3.0.2",[m
       "resolved": "https://registry.npmjs.org/extend/-/extend-3.0.2.tgz",[m
       "integrity": "sha512-fjquC59cD7CyW6urNXK0FBufkZcoiGG80wTuPujX590cB5Ttln20E2UB4S/WARVqhXffZl2LNgS+gQdPIIim/g==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[32m+[m[32m      "license": "MIT"[m
     },[m
     "node_modules/fast-deep-equal": {[m
       "version": "3.1.3",[m
       "resolved": "https://registry.npmjs.org/fast-deep-equal/-/fast-deep-equal-3.1.3.tgz",[m
       "integrity": "sha512-f3qQ9oQy9j2AhBe/H9VC91wLmKBCCU/gDOnKNAYG5hswO7BLKj09Hc5HYNz9cGI++xlpDCIgDaitVs03ATR84Q==",[m
[31m-      "license": "MIT",[m
[31m-      "optional": true[m
[32m+[m[32m      "license": "MIT"[m
     },[m
[31m-    "node_modules/fast-levenshtein": {[m
[31m-      "version": "2.0.6",[m
[31m-      "resolved": "https://registry.npmjs.org/fast-levenshtein/-/fast-levenshtein-2.0.6.tgz",[m
[31m-      "integrity": "sha512-DCXu6Ifhqcks7TZKY3Hxp3y6qphY5SJZmrWMDrKcERSOXWQdMhU9Ig/PYrzyw/ul9jOIyh0N4M0tbC5hodg8dw==",[m
[32m+[m[32m    "node_modules/fast-xml-builder": {[m
[32m+[m[32m      "version": "1.3.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/fast-xml-builder/-/fast-xml-builder-1.3.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-F74cZEdCvuw9P41GAC3rod4X04jjWGM1JPEv/GWSqFTWLsdyMSBMBMlm9Hk3GLBgLBbdBNY8yee0pQh2RBVESQ==",[m
[32m+[m[32m      "funding": [[m
[32m+[m[32m        {[m
[32m+[m[32m          "type": "github",[m
[32m+[m[32m          "url": "https://github.com/sponsors/NaturalIntelligence"[m
[32m+[m[32m        }[m
[32m+[m[32m      ],[m
       "license": "MIT",[m
[31m-      "optional": true[m
[31m-    },[m
[31m-    "node_modules/fast-text-encoding": {[m
[31m-      "version": "1.0.6",[m
[31m-      "resolved": "https://registry.npmjs.org/fast-text-encoding/-/fast-text-encoding-1.0.6.tgz",[m
[31m-      "integrity": "sha512-VhXlQgj9ioXCqGstD37E/HBeqEGV/qOD/kmbVG8h5xKBYvM1L3lR1Zn4555cQ8GkYbJa8aJSipLPndE1k6zK2w==",[m
[31m-      "license": "Apache-2.0",[m
[31m-      "optional": true[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "path-expression-matcher": "^1.6.2",[m
[32m+[m[32m        "xml-naming": "^0.3.0"[m
[32m+[m[32m      }[m
     },[m
     "node_modules/fast-xml-parser": {[m
[31m-      "version": "4.5.7",[m
[31m-      "resolved": "https://registry.npmjs.org/fast-xml-parser/-/fast-xml-parser-4.5.7.tgz",[m
[31m-      "integrity": "sha512-a6Qh1RMCNbSrU1+sAyAAZH3rTe+OaWJbNZIq0S+ifZciUUOQtlVxBJwoTUE2bYhysmG/RYyI5WJFIKdBahJdrQ==",[m
[32m+[m[32m      "version": "5.10.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/fast-xml-parser/-/fast-xml-parser-5.10.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-IEMIf7298kXuZSRFoGfMYrl7is8LpavODgbNz1cwIudv7KwVFnuU+UsMporfq6PD6aXSlawZlARiA3UywCTfMw==",[m
       "funding": [[m
         {[m
           "type": "github",[m
[36m@@ -1259,7 +1195,12 @@[m
       "license": "MIT",[m
       "optional": true,[m
       "dependencies": {[m
[31m-        "strnum": "^1.0.5"[m
[32m+[m[32m        "@nodable/entities": "^3.0.0",[m
[32m+[m[32m        "fast-xml-builder": "^1.2.0",[m
[32m+[m[32m        "is-unsafe": "^2.0.0",[m
[32m+[m[32m        "path-expression-matcher": "^1.6.2",[m
[32m+[m[32m        "strnum": "^2.4.1",[m
[32m+[m[32m        "xml-naming": "^0.3.0"[m
       },[m
       "bin": {[m
         "fxparser": "src/cli/cli.js"[m
[36m@@ -1277,6 +1218,29 @@[m
         "node": ">=0.8.0"[m
       }[m
     },[m
[32m+[m[32m    "node_modules/fetch-blob": {[m
[32m+[m[32m      "version": "3.2.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/fetch-blob/-/fetch-blob-3.2.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-7yAQpD2UMJzLi1Dqv7qFYnPbaPx7ZfFK6PiIxQ4PfkGPyNyl2Ugx+a/umUonmKqjhM4DnfbMvdX6otXq83soQQ==",[m
[32m+[m[32m      "funding": [[m
[32m+[m[32m        {[m
[32m+[m[32m          "type": "github",[m
[32m+[m[32m          "url": "https://github.com/sponsors/jimmywarting"[m
[32m+[m[32m        },[m
[32m+[m[32m        {[m
[32m+[m[32m          "type": "paypal",[m
[32m+[m[32m          "url": "https://paypal.me/jimmywarting"[m
[32m+[m[32m        }[m
[32m+[m[32m      ],[m
[32m+[m[32m      "license": "MIT",[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "node-domexception": "^1.0.0",[m
[32m+[m[32m        "web-streams-polyfill": "^3.0.3"[m
[32m+[m[32m      },[m
[32m+[m[32m      "engines": {[m
[32m+[m[32m        "node": "^12.20 || >= 14.13"[m
[32m+[m[32m      }[m
[32m+[m[32m    },[m
     "node_modules/finalhandler": {[m
       "version": "2.1.1",[m
       "resolved": "https://registry.npmjs.org/finalhandler/-/finalhandler-2.1.1.tgz",[m
[36m@@ -1299,52 +1263,114 @@[m
       }[m
     },[m
     "node_modules/firebase-admin": {[m
[31m-      "version": "11.11.1",[m
[31m-      "resolved": "https://registry.npmjs.org/firebase-admin/-/firebase-admin-11.11.1.tgz",[m
[31m-      "integrity": "sha512-UyEbq+3u6jWzCYbUntv/HuJiTixwh36G1R9j0v71mSvGAx/YZEWEW7uSGLYxBYE6ckVRQoKMr40PYUEzrm/4dg==",[m
[32m+[m[32m      "version": "14.2.0",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/firebase-admin/-/firebase-admin-14.2.0.tgz",[m
[32m+[m[32m      "integrity": "sha512-zfs5PdccEgjX479bbMmz95Rqc7ttQ4LV3qkGFlPiqOaOu/suBZc3fG52Qzn2hQjiSHkBM4NP2AZV5r2NvAt0TQ==",[m
       "license": "Apache-2.0",[m
       "dependencies": {[m
[31m-        "@fastify/busboy": "^1.2.1",[m
[31m-        "@firebase/database-compat": "^0.3.4",[m
[31m-        "@firebase/database-types": "^0.10.4",[m
[31m-        "@types/node": ">=12.12.47",[m
[32m+[m[32m        "@fastify/busboy": "^3.0.0",[m
[32m+[m[32m        "@firebase/database-compat": "^2.1.4",[m
[32m+[m[32m        "@firebase/database-types": "^1.0.20",[m
[32m+[m[32m        "fast-deep-equal": "^3.1.1",[m
[32m+[m[32m        "google-auth-library": "^10.6.2",[m
         "jsonwebtoken": "^9.0.0",[m
[31m-        "jwks-rsa": "^3.0.1",[m
[31m-        "node-forge": "^1.3.1",[m
[31m-        "uuid": "^9.0.0"[m
[32m+[m[32m        "jwks-rsa": "^4.0.1"[m
       },[m
       "engines": {[m
[31m-        "node": ">=14"[m
[32m+[m[32m        "node": ">=22"[m
       },[m
       "optionalDependencies": {[m
[31m-        "@google-cloud/firestore": "^6.8.0",[m
[31m-        "@google-cloud/storage": "^6.9.5"[m
[32m+[m[32m        "@google-cloud/firestore": "^8.6.0",[m
[32m+[m[32m        "@google-cloud/storage": "^7.19.0"[m
       }[m
     },[m
[31m-    "node_modules/forwarded": {[m
[31m-      "version": "0.2.0",[m
[31m-      "resolved": "https://registry.npmjs.org/forwarded/-/forwarded-0.2.0.tgz",[m
[31m-      "integrity": "sha512-buRG0fpBtRHSTCOASe6hD258tEubFoRLb4ZNA6NxMVHNw2gOcwHo9wyablzMzOA5z9xA9L1KNjk/Nt6MT9aYow==",[m
[31m-      "license": "MIT",[m
[32m+[m[32m    "node_modules/foreground-child": {[m
[32m+[m[32m      "version": "3.3.1",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/foreground-child/-/foreground-child-3.3.1.tgz",[m
[32m+[m[32m      "integrity": "sha512-gIXjKqtFuWEgzFRJA9WCQeSJLZDjgJUOMCMzxtvFq/37KojM1BFGufqsCy0r4qSQmYLsZYMeyRqzIWOMup03sw==",[m
[32m+[m[32m      "license": "ISC",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "cross-spawn": "^7.0.6",[m
[32m+[m[32m        "signal-exit": "^4.0.1"[m
[32m+[m[32m      },[m
       "engines": {[m
[31m-        "node": ">= 0.6"[m
[32m+[m[32m        "node": ">=14"[m
[32m+[m[32m      },[m
[32m+[m[32m      "funding": {[m
[32m+[m[32m        "url": "https://github.com/sponsors/isaacs"[m
       }[m
     },[m
[31m-    "node_modules/fresh": {[m
[31m-      "version": "2.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/fresh/-/fresh-2.0.0.tgz",[m
[31m-      "integrity": "sha512-Rx/WycZ60HOaqLKAi6cHRKKI7zxWbJ31MhntmtwMoaTeF7XFH9hhBp8vITaMidfljRQ6eYWCKkaTK+ykVJHP2A==",[m
[32m+[m[32m    "node_modules/form-data": {[m
[32m+[m[32m      "version": "2.5.6",[m
[32m+[m[32m      "resolved": "https://registry.npmjs.org/form-data/-/form-data-2.5.6.tgz",[m
[32m+[m[32m      "integrity": "sha512-Ogz/E85h9tlfJzpI6TuFpGcHZFhLrb9Gw8wq9v40CxSCPnv7ahKr6Xgtkn0KYCDQJ8DNn5VoMO8EXr9V5PadyA==",[m
       "license": "MIT",[m
[32m+[m[32m      "optional": true,[m
[32m+[m[32m      "dependencies": {[m
[32m+[m[32m        "asynckit": "^0.4.0",[m
[32m+[m[32m        "combined-stream": "^1.0.8",[m
[32m+[m[32m        "es-set-tostringtag": "^2.1.0",[m
[32m+[m[32m        "hasown": "^2.0.4",[m
[32m+[m[32m        "mime-types": "^2.1.35",[m
[32m+[m[32m        "safe-buffer": "^5.2.1"[m
[32m+[m[32m      },[m
       "engines": {[m
[31m-        "node": ">= 0.8"[m
[32m+[m[32m        "node": ">= 0.12"[m
       }[m
     },[m
[31m-    "node_modules/fs.realpath": {[m
[31m-      "version": "1.0.0",[m
[31m-      "resolved": "https://registry.npmjs.org/fs.r